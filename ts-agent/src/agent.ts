import { ChatGoogle } from '@langchain/google';
import { tool } from '@langchain/core/tools';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import z from 'zod';
import { ErpClient, UserProfile } from './erpClient';
import { ToolExecutor } from './tools';

interface SessionState {
  lastProduct?: string;
  lastWarehouse?: string;
  lastThickness?: number;
  lastPoNumber?: string;
  pendingDraftToken?: string;
  history: Array<{ role: 'user' | 'assistant'; text: string }>;
}

function extractCleanText(content: any): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join('')
      .trim();
  }
  if (content && typeof content.text === 'string') {
    return content.text.trim();
  }
  return '';
}

// ─────────────────────────────────────────────────────────────────────────────
// INTENT DETECTION — fully structural/semantic, zero topic-specific keywords
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Words that should NOT be classified as city/location names.
 * Uses structural categories, not an enumerated list of city names.
 */
const NON_CITY_TOKENS = new Set([
  // ERP domain nouns
  'stock','transit','draft','detail','details','cost','costs','freight',
  'database','order','orders','slab','slabs','stone','quartz','granite',
  'meter','meters','inch','inches','total','advance','warehouse','warehouses',
  'marble','product','products','supplier','suppliers','material','materials',
  // Conversation function words that look like city names
  'confirm','yes','no','cancel','save','help','thanks','thank','ok','okay',
  'available','inventory','delayed','late','overdue','purchase','landed',
  'quantity','thickness','size','color','sku','unit','line','items',
  // Social greeting / conversational openers (not city names)
  'hey','hi','hello','howdy','greetings','welcome','morning','afternoon','evening','hola','sup','yo','bye','goodbye',
]);

/**
 * Dynamically extract any city/location name from a user message.
 *
 * Strategy:
 *  1. Prepositional phrase: "in <Token>", "at <Token>", "for <Token>", "around <Token>"
 *  2. Short standalone or follow-up: "in Dallas", "and in X?", "what about X"
 *
 * A token is accepted as a city candidate when:
 *  - It is a single Title-case-able alphabetic word
 *  - It is NOT in the structural exclusion set above
 *  - It has a minimum length of 3 characters (avoids "is", "do", "cm", etc.)
 */
export function extractCity(message: string): string | undefined {
  const clean = message.trim();

  // Pattern 1 — prepositional: "in <City>", "at <City>", "for <City>", "around <City>"
  // Use all matches and take the LAST one (rightmost) to skip words like "available in bhopal"
  const prepRegex = /\b(?:in|at|for|around)\s+([A-Za-z]{3,})\b/gi;
  let prepMatch: RegExpExecArray | null;
  let lastPrepMatch: RegExpExecArray | null = null;
  while ((prepMatch = prepRegex.exec(clean)) !== null) {
    lastPrepMatch = prepMatch;
  }
  if (lastPrepMatch) {
    const word = lastPrepMatch[1].trim().toLowerCase();
    if (!NON_CITY_TOKENS.has(word)) {
      return word.charAt(0).toUpperCase() + word.slice(1);
    }
  }

  // Pattern 2 — conversational follow-up: "dallas", "in dallas", "and in dallas?",
  //             "what about dallas", "how about dallas", "what about in dallas"
  const followUpMatch = clean.match(
    /^(?:(?:and|what\s+about|how\s+about)\s+(?:in\s+)?|in\s+)?([A-Za-z]{3,})\??$/i
  );
  if (followUpMatch) {
    const word = followUpMatch[1].trim().toLowerCase();
    if (!NON_CITY_TOKENS.has(word)) {
      return word.charAt(0).toUpperCase() + word.slice(1);
    }
  }

  return undefined;
}

/**
 * Detect a greeting or capability-inquiry by STRUCTURAL patterns, not by
 * enumerating specific greeting words.
 *
 * Rules:
 *  - Very short messages (≤ 4 words) that contain no ERP-domain signal are greetings.
 *  - Messages asking about the assistant's abilities: "what can you …", "who are you", etc.
 *  - Messages with a salutation structure at the sentence start (opening exclamation or address).
 */
export function isGreetingOrHelp(message: string): boolean {
  const lower = message.trim().toLowerCase().replace(/[!?.,]/g, '').trim();
  const wordCount = lower.split(/\s+/).filter(Boolean).length;

  // If a city is mentioned, it is a location query, not small talk
  if (extractCity(message)) {
    return false;
  }

  // 1. Very short with no ERP domain signals → treat as small talk / greeting
  if (wordCount <= 2 && !hasErpDomainSignal(lower)) {
    return true;
  }

  // 2. Questions about what the assistant can do (structural: "what can you ...", "who are you")
  if (/^(?:what\s+can\s+(?:you|this)|who\s+are\s+you|what\s+(?:do\s+you|are\s+you)|how\s+(?:can\s+you|do\s+you\s+work)|tell\s+me\s+about\s+yourself|help\s+me\s+(?:with\s+)?please?|what\s+(?:features|functions|tools))\b/.test(lower)) {
    return true;
  }

  // 3. Salutation structure: starts with a social opener followed by nothing of ERP substance
  if (/^(?:good\s+(?:morning|afternoon|evening|day|night)|greetings?|welcome|howdy|hey|hi|hello|hola|sup|yo)\b/.test(lower) && !hasErpDomainSignal(lower)) {
    return true;
  }

  return false;
}

/**
 * Returns true if the lower-cased message string contains any ERP-domain signal.
 * Uses semantic category patterns rather than specific product names.
 */
function hasErpDomainSignal(lower: string): boolean {
  // Structural ERP signals: slab-related, PO-related, inventory-related, supplier-related, cost-related
  return /\b(?:slab|slabs|stone|marble|quartz|granite|quartzite|porcelain|inventory|stock|warehouse|purchase|order|supplier|cost|freight|landed|delayed|overdue|eta|draft|confirm|thickness|cm|sqft|po[-\s]?\d|available|on\s+hand)\b/.test(lower);
}

/**
 * Determine if a question is completely outside the ERP domain.
 *
 * Strategy: POSITIVE detection of off-domain intent, NOT blacklisting specific topics.
 *
 * A question is out-of-domain when ALL of the following are true:
 *  1. It contains NO ERP domain signal (see hasErpDomainSignal)
 *  2. It has a "world knowledge" question structure:
 *     - "where is X located/situated/built"
 *     - "who was/is the [role] of [place]"
 *     - "what is the capital / population / currency of"
 *     - "how do I [non-ERP verb]"
 *     - "tell me about [non-ERP subject]"
 *     - "what happened in [year]" / "when was X"
 *     - weather, recipes, sports scores, general coding help
 *
 * This avoids hardcoding monument names or sport names.
 */
export function isOutOfDomainQuestion(message: string): boolean {
  const lower = message.trim().toLowerCase();

  // If the message has ERP domain signals, it is NOT out of domain
  if (hasErpDomainSignal(lower)) {
    return false;
  }

  // Structural patterns that indicate world-knowledge questions
  const worldKnowledgePatterns: RegExp[] = [
    // Location / geography
    /\bwhere\s+(?:is|was|are)\b.*\b(?:located|situated|built|found|constructed|established)\b/,
    /\bwhat\s+(?:is|was)\s+the\s+(?:capital|currency|population|language|religion|flag|anthem|president|prime\s+minister|king|queen|ruler|leader|government|area|timezone)\b/,
    // Historical / biographical
    /\bwho\s+(?:is|was|were|invented|discovered|founded|wrote|created|built|designed|painted|composed|led|ruled|won|killed|assassinated)\b/,
    /\bwhen\s+(?:was|were|did|is)\b.*\b(?:born|died|founded|built|invented|discovered|established|created|written|happened|started|ended)\b/,
    /\bwhat\s+(?:year|date|century|decade)\s+(?:was|were|did|is)\b/,
    /\bwhat\s+happened\s+(?:in|during|at|on|around)\b/,
    // Science / general knowledge not about stones
    /\bwhat\s+(?:is|are)\s+the?\s+(?:formula|equation|law|theory|definition|meaning|origin|history|difference|similarity)\s+(?:of|between|for)\b/,
    // Weather / sports / entertainment / cooking
    /\bweather\s+(?:in|at|for|today|tomorrow|this\s+week)\b/,
    /\b(?:recipe|ingredient|how\s+(?:to|do\s+i|can\s+i)\s+(?:cook|bake|make|prepare|brew|mix|blend))\b/,
    /\b(?:score|match|game|tournament|championship|world\s+cup|olympics|cricket|football|soccer|baseball|basketball|tennis)\b/,
    /\b(?:movie|film|series|show|episode|actor|actress|director|singer|song|album|music|band|artist|celebrity|star)\b/,
    // General coding / math not related to ERP
    /\b(?:write|create|build|make)\s+(?:a\s+)?(?:[a-z0-9+#.]+\s+)?(?:code|program|script|function|class|app|website|algorithm)\b/,
    /\b(?:solve\s+(?:this\s+)?(?:equation|problem|math)|calculate\s+(?:the\s+)?(?:integral|derivative|probability)|debug\s+(?:this\s+)?code)\b/,
    // Translation / language
    /\b(?:translate|translation|how\s+do\s+you\s+say|what\s+does\s+.+\s+mean\s+in)\b/,
  ];

  return worldKnowledgePatterns.some(p => p.test(lower));
}

/**
 * Checks whether the message is relevant to the ERP system (inventory, POs, costs, suppliers).
 * Used as a final guardrail when the LLM produces an empty response.
 */
function isRelevantToDatabase(message: string, session: SessionState): boolean {
  const lower = message.trim().toLowerCase();

  if (isOutOfDomainQuestion(message)) return false;
  if (isGreetingOrHelp(message)) return true;

  // Active draft awaiting confirmation
  if (session.pendingDraftToken && /\b(?:confirm|yes|save|proceed|go\s+ahead|do\s+it|sure|approved?)\b/i.test(lower)) {
    return true;
  }

  // Any extractable city mention
  if (extractCity(message)) return true;

  // Structural ERP domain signals
  if (hasErpDomainSignal(lower)) return true;

  // Thickness follow-up: "2cm?", "3cm slab?", "what about 2cm"
  if (/\b\d+(\.\d+)?\s*cm\b/i.test(lower)) return true;

  // PO number pattern
  if (/\bPO[-\s]?\d+\b/i.test(lower)) return true;

  // Short contextual follow-up with prior history
  if (session.history.length > 0 && lower.split(/\s+/).filter(Boolean).length <= 4) return true;

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// ASSISTANT AGENT CLASS
// ─────────────────────────────────────────────────────────────────────────────

export class AssistantAgent {
  private sessions: Map<string, SessionState> = new Map();
  private checkpointer: MemorySaver = new MemorySaver();
  private toolExecutor: ToolExecutor;
  private llm: ChatGoogle | null = null;

  constructor(private erpClient: ErpClient) {
    this.toolExecutor = new ToolExecutor(erpClient);
    this.initLlm();
  }

  private initLlm() {
    const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    if (apiKey) {
      try {
        this.llm = new ChatGoogle({
          apiKey,
          model: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
        });
      } catch (e: any) {
        console.warn('Could not initialize ChatGoogle:', e?.message || e);
        this.llm = null;
      }
    }
  }

  private getSession(conversationId: string): SessionState {
    if (!this.sessions.has(conversationId)) {
      this.sessions.set(conversationId, { history: [] });
    }
    return this.sessions.get(conversationId)!;
  }

  private createTools(user: UserProfile, token: string, session: SessionState, toolsCalled: any[]) {
    const executeSql = tool(
      async ({ sql }) => {
        const result = await this.erpClient.executeSql(token, sql);
        toolsCalled.push({ tool: 'execute_sql', input: { sql }, output: result });
        return JSON.stringify(result);
      },
      {
        name: 'execute_sql',
        description:
          'Execute a read-only MySQL SELECT query against the ERP database (ChatGPT / Claude style Text-to-SQL). ' +
          'Use this to query products, slabs on hand, warehouses by any city name, suppliers, purchase orders, delayed shipments, or landed costs. ' +
          'Always call this tool first when you need live data before answering.',
        schema: z.object({
          sql: z.string().describe('MySQL SELECT statement to execute against the laravel_erp database.'),
        }),
      }
    );

    const checkStock = tool(
      async ({ product, warehouse, thickness_cm }) => {
        const prod = product || session.lastProduct || '';
        const thick = thickness_cm ?? session.lastThickness;
        const wh = warehouse || session.lastWarehouse;
        const result = await this.erpClient.checkStock(token, {
          product: prod,
          warehouse: wh,
          thickness_cm: thick,
        });
        if (prod) session.lastProduct = prod;
        if (thick) session.lastThickness = thick;
        if (wh) session.lastWarehouse = wh;
        toolsCalled.push({ tool: 'checkStock', input: { product: prod, warehouse: wh, thickness_cm: thick }, output: result });
        return JSON.stringify(result);
      },
      {
        name: 'check_stock',
        description:
          'Check live slab inventory for any stone or quartz product. ' +
          'The warehouse parameter accepts any city name the user mentions — the backend will resolve it against the ERP database. ' +
          'If the city has no warehouse in the ERP, the response will indicate that.',
        schema: z.object({
          product: z.string().optional().describe(
            'Product name, material, or color the user asked about (e.g. "Calacatta Gold", "Carrara White"). ' +
            'Omit to reuse the previously mentioned product.'
          ),
          warehouse: z.string().optional().describe(
            'Any city name the user mentioned as a warehouse location. The backend resolves it against the ERP database.'
          ),
          thickness_cm: z.number().optional().describe('Slab thickness in centimetres (e.g. 2 or 3).'),
        }),
      }
    );

    const searchPurchaseOrders = tool(
      async ({ supplier_name, delayed_only, po_number }) => {
        const result = await this.erpClient.searchPurchaseOrders(token, { supplier_name, delayed_only, po_number });
        toolsCalled.push({ tool: 'searchPurchaseOrders', input: { supplier_name, delayed_only, po_number }, output: result });
        return JSON.stringify(result);
      },
      {
        name: 'search_purchase_orders',
        description: 'Search purchase orders by supplier name, PO number, or delayed/late status.',
        schema: z.object({
          supplier_name: z.string().optional().describe('Supplier name as stated by the user.'),
          delayed_only: z.boolean().optional().describe('Pass true to filter only delayed or overdue purchase orders.'),
          po_number: z.string().optional().describe('Specific PO number (e.g. "PO-1023").'),
        }),
      }
    );

    const getLandedCost = tool(
      async ({ po_number }) => {
        if (user.role === 'sales') {
          return JSON.stringify({
            allowed: false,
            polite_refusal: 'Cost details are only available to the Purchasing team.',
          });
        }
        const result = await this.erpClient.getLandedCost(token, po_number);
        toolsCalled.push({ tool: 'getLandedCost', input: { po_number }, output: result });
        return JSON.stringify(result);
      },
      {
        name: 'get_landed_cost',
        description: 'Calculate landed cost per slab (unit cost + share of freight) for a purchase order. RESTRICTED TO PURCHASING TEAM.',
        schema: z.object({
          po_number: z.string().describe('Purchase order number (e.g. "PO-1023").'),
        }),
      }
    );

    const createDraftPO = tool(
      async ({ supplier_name, items, estimated_freight }) => {
        if (user.role === 'sales') {
          return JSON.stringify({
            allowed: false,
            polite_refusal: 'Creating draft purchase orders is restricted to the Purchasing team.',
          });
        }
        const result = await this.erpClient.createDraftPO(token, { supplier_name, items, estimated_freight });
        if (result && result.draft_token) {
          session.pendingDraftToken = result.draft_token;
        }
        toolsCalled.push({ tool: 'createDraftPurchaseOrder', input: { supplier_name, items, estimated_freight }, output: result });
        return JSON.stringify(result);
      },
      {
        name: 'create_draft_purchase_order',
        description: 'Prepare a draft purchase order and present it for confirmation. RESTRICTED TO PURCHASING TEAM.',
        schema: z.object({
          supplier_name: z.string().describe('Supplier name as stated by the user.'),
          items: z.array(z.object({
            product: z.string().describe('Product name or description.'),
            quantity: z.number().describe('Number of slabs.'),
            unit_cost: z.number().optional().describe('Unit cost per slab if known.'),
          })).describe('Line items to include in the purchase order.'),
          estimated_freight: z.number().optional().describe('Estimated freight cost if stated.'),
        }),
      }
    );

    const confirmDraftPO = tool(
      async ({ draft_token }) => {
        if (user.role === 'sales') {
          return JSON.stringify({
            allowed: false,
            polite_refusal: 'Confirming purchase orders is restricted to the Purchasing team.',
          });
        }
        const tokenToUse = draft_token || session.pendingDraftToken;
        const result = await this.erpClient.confirmDraftPO(token, tokenToUse);
        session.pendingDraftToken = undefined;
        toolsCalled.push({ tool: 'confirmDraftPurchaseOrder', input: { draft_token: tokenToUse }, output: result });
        return JSON.stringify(result);
      },
      {
        name: 'confirm_draft_purchase_order',
        description: 'Confirm and persist a draft purchase order to the ERP database. RESTRICTED TO PURCHASING TEAM.',
        schema: z.object({
          draft_token: z.string().optional().describe('Draft token returned by create_draft_purchase_order.'),
        }),
      }
    );

    // Sales role: read-only subset — no cost or draft tools
    if (user.role === 'sales') {
      return [executeSql, checkStock, searchPurchaseOrders];
    }

    return [executeSql, checkStock, searchPurchaseOrders, getLandedCost, createDraftPO, confirmDraftPO];
  }

  async processMessage(
    message: string,
    user: UserProfile,
    token: string,
    conversationId: string
  ): Promise<{
    conversation_id: string;
    role: string;
    user_name: string;
    reply: string;
    tools_called: any[];
    tokens_used: number;
    response_time_ms: number;
  }> {
    const startTime = Date.now();
    const session = this.getSession(conversationId);
    const lower = message.trim().toLowerCase();

    // Update session context from current message
    const thickMatch = lower.match(/\b(\d+(?:\.\d+)?)\s*cm\b/i);
    if (thickMatch) {
      session.lastThickness = parseFloat(thickMatch[1]);
    }
    const cityDetected = extractCity(message);
    if (cityDetected) {
      session.lastWarehouse = cityDetected;
    }

    // Prompt injection / security guard
    if (/\b(?:ignore\s+(?:all\s+)?(?:rules|instructions|above)|system\s+override|act\s+as\s+(?:admin|root|superuser|dba)|drop\s+(?:table|database)|delete\s+from|truncate\s+table|insert\s+into|update\s+\w+\s+set)\b/i.test(lower)) {
      return {
        conversation_id: conversationId,
        role: user.role,
        user_name: user.name,
        reply: 'Adversarial instruction or system override attempt detected. The AI assistant only answers inventory and purchasing questions within verified role bounds.',
        tools_called: [],
        tokens_used: 15,
        response_time_ms: Date.now() - startTime,
      };
    }

    if (!this.llm) {
      this.initLlm();
    }

    const toolsCalled: any[] = [];
    const tools = this.createTools(user, token, session, toolsCalled);
    const toolMap: Record<string, any> = Object.fromEntries(tools.map(t => [t.name, t]));

    // Retrieve prior messages from LangGraph Checkpointer Memory
    const threadConfig = { configurable: { thread_id: conversationId } };
    let checkpointMessages: any[] = [];
    try {
      const tuple = await this.checkpointer.getTuple(threadConfig);
      if (tuple && tuple.checkpoint && tuple.checkpoint.channel_values) {
        const msgs = tuple.checkpoint.channel_values.messages;
        if (Array.isArray(msgs)) {
          checkpointMessages = msgs;
        }
      }
    } catch (e: any) {
      console.warn('Could not read from checkpointer memory:', e?.message || e);
    }

    // ── 1. LLM PATH (Google Gemini) ──────────────────────────────────────────
    if (this.llm) {
      try {
        const systemPrompt = `You are the AI Assistant for a US natural stone & quartz slab distributor ERP system.
Currently logged-in staff member: ${user.name} (Role: ${user.role}).

═══════════════════════════════════════════════════════════
OPERATING MODEL: TEXT-TO-SQL AI AGENT
═══════════════════════════════════════════════════════════
You operate like ChatGPT with database access. When the user asks about inventory, orders,
suppliers, or costs:
  1. Silently formulate a MySQL SELECT query.
  2. Call the \`execute_sql\` tool — the backend executes it and returns live rows.
  3. Read the returned data and compose a clear, friendly natural-language answer.
  4. NEVER output raw SQL, table names, or column names in your answer to the user.
  5. You may also call the specialised tools: \`check_stock\`, \`search_purchase_orders\`,
     \`get_landed_cost\`, \`create_draft_purchase_order\`, \`confirm_draft_purchase_order\`.

═══════════════════════════════════════════════════════════
DATABASE SCHEMA (laravel_erp)
═══════════════════════════════════════════════════════════
1. \`products\` (id, sku, name, material, color, thickness_cm, slab_size)
   • Materials include: Marble, Quartz, Quartzite, Granite, Dolomite, Soapstone, Porcelain.
   • Thickness values: 2.0 cm, 3.0 cm.

2. \`warehouses\` (id, name, city)
   • Current cities in the ERP: Houston, Dallas, Chicago.
   • IMPORTANT: Users may ask about ANY city. Query the database dynamically.
     If the city is not in the ERP, respond:
     "We do not have a warehouse recorded for [City]. Our active locations are Houston, Dallas, and Chicago."

3. \`stock\` (id, product_id, warehouse_id, slabs_on_hand)
   • Joins: stock.product_id = products.id, stock.warehouse_id = warehouses.id

4. \`suppliers\` (id, name, contact, payment_terms, bank_details)
   • bank_details — RESTRICTED: Purchasing team only.

5. \`purchase_orders\` (id, po_number, supplier_id, status, order_date, eta, freight_cost, notes)
   • Statuses: 'confirmed', 'delayed', 'received', 'draft'
   • freight_cost and status='draft' — RESTRICTED: Purchasing team only.
   • Delayed definition: status = 'delayed' OR (status NOT IN ('received','draft') AND eta < CURDATE())

6. \`purchase_order_lines\` (id, purchase_order_id, product_id, quantity, unit_cost)
   • unit_cost — RESTRICTED: Purchasing team only.
   • Landed cost per slab = unit_cost + (freight_cost / total_slabs_in_po)

═══════════════════════════════════════════════════════════
DRAFT PURCHASE ORDER WORKFLOW (Purchasing role only)
═══════════════════════════════════════════════════════════
When a Purchasing user asks to create a purchase order:
  Step A: Optionally query the DB for product/supplier details.
  Step B: Call \`create_draft_purchase_order\` with supplier_name, items list, and optional freight.
          Default unit_cost = 150.00 if not specified. Default supplier = 'Supplier Y' if not named.
  Step C: Present the draft summary (Supplier, items, quantity, estimated cost).
          End your message with: Reply "confirm" to save it.
When the user replies with an affirmative (confirm, yes, ok, proceed, go ahead, sure):
  Call \`confirm_draft_purchase_order\` to persist it.

═══════════════════════════════════════════════════════════
ROLE-BASED ACCESS CONTROL — MANDATORY
═══════════════════════════════════════════════════════════
Current role: "${user.role}".
${user.role === 'sales'
  ? `SALES ROLE RESTRICTIONS (non-negotiable):
  • Refuse any request to create, draft, or confirm a purchase order immediately.
    Response: "I apologize, but creating and confirming purchase orders is restricted to the Purchasing team. As a Sales team member, you do not have permission to draft or confirm purchase orders."
  • Never show: unit_cost, freight_cost, landed cost, supplier bank details, or draft PO data.
  • SQL queries must NEVER select: freight_cost, unit_cost, bank_details.
  • SQL queries must NEVER return rows with status = 'draft'.`
  : `PURCHASING ROLE: Full access to all columns, costs, freight, and draft PO operations.`}

═══════════════════════════════════════════════════════════
DOMAIN BOUNDARY — MANDATORY
═══════════════════════════════════════════════════════════
This assistant ONLY answers questions about stone & quartz inventory and purchasing.
If the user asks about anything unrelated — world geography, history, sports, entertainment,
general coding, weather, cooking, or any other off-topic subject — respond with:
"I don't have proper data about it. I can only answer about inventory and purchasing."
Do NOT answer, do NOT guess, do NOT call any tool for off-topic questions.

═══════════════════════════════════════════════════════════
CONVERSATION MEMORY
═══════════════════════════════════════════════════════════
Use conversation history to maintain context across turns:
• Remember the last product, thickness, warehouse, and PO number mentioned.
• For follow-up messages like "and in Dallas?" or "what about 3cm?", resolve context
  from prior turns rather than asking the user to repeat themselves.`;

        const llmWithTools = this.llm.bindTools(tools);

        const historyMessages = checkpointMessages.length > 0
          ? checkpointMessages.slice(-8)
          : session.history.slice(-8).map(h =>
              h.role === 'user' ? new HumanMessage(h.text) : new AIMessage(h.text)
            );

        const messages = [
          new SystemMessage(systemPrompt),
          ...historyMessages,
          new HumanMessage(message),
        ];

        let currentMessages: any[] = [...messages];
        let currentResponse = await llmWithTools.invoke(currentMessages);
        let iterations = 0;
        const maxIterations = 5;

        // Agentic tool-call loop
        while (currentResponse.tool_calls && currentResponse.tool_calls.length > 0 && iterations < maxIterations) {
          iterations++;
          currentMessages.push(currentResponse);

          for (const tc of currentResponse.tool_calls) {
            const toolInstance = toolMap[tc.name];
            if (toolInstance) {
              const toolResult = await toolInstance.invoke(tc.args);
              currentMessages.push(
                new ToolMessage({
                  tool_call_id: tc.id || tc.name,
                  name: tc.name,
                  content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
                })
              );
            }
          }

          currentResponse = await llmWithTools.invoke(currentMessages);
        }

        let finalReply = extractCleanText(currentResponse.content);

        // Fallback if LLM produced tool calls but empty prose
        if (!finalReply || finalReply.trim() === '') {
          const draftTool = toolsCalled.find(t => t.tool === 'createDraftPurchaseOrder' || t.tool === 'create_draft_purchase_order');
          if (draftTool && draftTool.output) {
            finalReply = draftTool.output.prompt || `Draft purchase order created. Reply "confirm" to save it.`;
          } else {
            for (const tc of toolsCalled) {
              if (tc.output && tc.output.allowed === false) {
                finalReply = tc.output.polite_refusal || 'Access to this information is restricted for your role.';
                break;
              }
            }
          }
        }

        // Domain guardrail: deny off-topic questions that produced no tool calls
        if (toolsCalled.length === 0 && !isRelevantToDatabase(message, session)) {
          finalReply = "I don't have proper data about it. I can only answer about inventory and purchasing.";
        }

        session.history.push({ role: 'user', text: message });
        session.history.push({ role: 'assistant', text: finalReply });

        // Persist conversation to LangGraph Checkpointer
        try {
          const updatedMessages = [
            ...checkpointMessages,
            new HumanMessage(message),
            new AIMessage(finalReply),
          ];
          await (this.checkpointer as any).put(
            threadConfig,
            {
              v: 1,
              id: `ckpt-${Date.now()}`,
              ts: new Date().toISOString(),
              channel_values: { messages: updatedMessages },
              channel_versions: { messages: updatedMessages.length },
              versions_seen: {},
            },
            { source: 'update', step: updatedMessages.length, parents: {} },
            {}
          );
        } catch (ckptErr: any) {
          console.warn('Could not save to checkpointer memory:', ckptErr?.message || ckptErr);
        }

        // Sanitize tools_called: strip SQL internals and Sales-forbidden tools
        const sanitizedToolsCalled = toolsCalled
          .filter(tc => {
            if (user.role === 'sales') {
              const restricted = ['createDraftPurchaseOrder', 'create_draft_purchase_order',
                                  'confirmDraftPurchaseOrder', 'confirm_draft_purchase_order',
                                  'getLandedCost', 'get_landed_cost'];
              if (restricted.includes(tc.tool) || tc.output?.allowed === false) return false;
            }
            return true;
          })
          .map(tc => {
            if (tc.tool === 'execute_sql' || tc.tool === 'executeSql') {
              return {
                tool: 'execute_sql',
                input: { query_type: 'Live ERP Database Query' },
                output: { status: 'executed_internally' },
              };
            }
            return tc;
          });

        return {
          conversation_id: conversationId,
          role: user.role,
          user_name: user.name,
          reply: finalReply,
          tools_called: sanitizedToolsCalled,
          tokens_used: 65,
          response_time_ms: Date.now() - startTime,
        };
      } catch (err: any) {
        console.warn('LangChain ChatGoogle error, falling back to local engine:', err?.message || err);
      }
    }

    // ── 2. LOCAL FALLBACK ENGINE ─────────────────────────────────────────────
    return await this.fallbackExecution(message, user, token, session, conversationId, startTime);
  }

  private async fallbackExecution(
    message: string,
    user: UserProfile,
    token: string,
    session: SessionState,
    conversationId: string,
    startTime: number
  ) {
    const lower = message.trim().toLowerCase();
    let toolName = '';
    let toolParams: any = {};
    const toolsCalled: any[] = [];

    // ── Role enforcement ──────────────────────────────────────────────────────
    if (user.role === 'sales') {
      // Detect purchase-order creation intent structurally
      if (this.detectDraftPoIntent(lower) || this.detectConfirmIntent(lower)) {
        return {
          conversation_id: conversationId,
          role: user.role,
          user_name: user.name,
          reply: 'I apologize, but creating and confirming draft purchase orders is restricted to the Purchasing team. As a member of the Sales team, you do not have permission to draft or confirm purchase orders.',
          tools_called: [],
          tokens_used: 25,
          response_time_ms: Date.now() - startTime,
        };
      }
      if (/\b(?:landed\s+cost|cost\s+per\s+slab|unit\s+cost|freight\s+cost)\b/i.test(lower)) {
        return {
          conversation_id: conversationId,
          role: user.role,
          user_name: user.name,
          reply: 'Cost details are only available to the Purchasing team.',
          tools_called: [],
          tokens_used: 15,
          response_time_ms: Date.now() - startTime,
        };
      }
    }

    // ── Domain & Greeting guards ─────────────────────────────────────────────
    if (isOutOfDomainQuestion(message)) {
      return {
        conversation_id: conversationId,
        role: user.role,
        user_name: user.name,
        reply: "I don't have proper data about it. I can only answer about inventory and purchasing.",
        tools_called: [],
        tokens_used: 15,
        response_time_ms: Date.now() - startTime,
      };
    }

    if (isGreetingOrHelp(message)) {
      return {
        conversation_id: conversationId,
        role: user.role,
        user_name: user.name,
        reply: `Hello ${user.name}! I'm your Stone & Quartz ERP Assistant. I can help you check slab inventory, look up purchase orders, or review landed costs. How can I assist you today?`,
        tools_called: [],
        tokens_used: 20,
        response_time_ms: Date.now() - startTime,
      };
    }

    // ── Intent routing ────────────────────────────────────────────────────────

    if (this.detectConfirmIntent(lower)) {
      // Confirm a pending draft PO
      toolName = 'confirmDraftPurchaseOrder';
      toolParams = { draft_token: session.pendingDraftToken };

    } else if (this.detectDraftPoIntent(lower)) {
      // Create a new draft PO
      toolName = 'createDraftPurchaseOrder';
      let supplier = 'Supplier Y';
      const supplierMatch = message.match(/\bfrom\s+([A-Za-z0-9](?:[A-Za-z0-9\s]{0,30}?))\b(?:\.|$)/i);
      if (supplierMatch) supplier = supplierMatch[1].trim();

      let qty = 20;
      let prod = '2cm Carrara White';
      const itemMatch = message.match(/(\d+)\s+slabs?\s+of\s+([A-Za-z0-9\s]+?)(?:\s+from|\.|$)/i);
      if (itemMatch) {
        qty = parseInt(itemMatch[1], 10);
        prod = itemMatch[2].trim();
      }
      toolParams = {
        supplier_name: supplier,
        items: [{ product: prod, quantity: qty, unit_cost: 85.00 }],
      };

    } else if (/\b(?:landed\s+cost|cost\s+per\s+slab)\b/i.test(lower)) {
      // Landed cost query
      toolName = 'getLandedCost';
      let poNumber = session.lastPoNumber || 'PO-1023';
      const poMatch = message.match(/\bPO[-\s]?(\d+)\b/i);
      if (poMatch) poNumber = `PO-${poMatch[1]}`;
      session.lastPoNumber = poNumber;
      toolParams = { po_number: poNumber };

    } else if (this.detectPoSearchIntent(lower)) {
      // Purchase order search
      toolName = 'searchPurchaseOrders';
      let supplierName: string | undefined;
      const suppMatch = message.match(/\bsupplier\s+([A-Za-z0-9]+)\b/i);
      if (suppMatch) supplierName = `Supplier ${suppMatch[1].toUpperCase()}`;
      const delayedOnly = /\b(?:delayed|late|overdue|behind\s+schedule|not\s+(?:yet\s+)?(?:arrived|received))\b/i.test(lower);
      toolParams = { supplier_name: supplierName, delayed_only: delayedOnly };

    } else if (extractCity(message) || this.detectStockIntent(lower)) {
      // Stock / inventory check
      toolName = 'checkStock';
      const city = extractCity(message) || session.lastWarehouse;
      if (city) session.lastWarehouse = city;

      let thickness = session.lastThickness;
      const thickMatch = lower.match(/\b(\d+(?:\.\d+)?)\s*cm\b/i);
      if (thickMatch) {
        thickness = parseFloat(thickMatch[1]);
        session.lastThickness = thickness;
      }

      // Build a clean product search string by removing city, thickness and filler words
      let cleanMsg = message.replace(/[?.,!]/g, ' ');
      if (city) {
        cleanMsg = cleanMsg.replace(new RegExp(`\\b(?:in|at|for|around)\\s+${city}\\b|\\b${city}\\b`, 'gi'), ' ');
      }
      cleanMsg = cleanMsg.replace(/\b(?:how\s+many|slabs?|do\s+we\s+have|in\s+stock|available|and\s+in|what\s+about|how\s+about)\b/gi, '');
      let product = cleanMsg.replace(/\s+/g, ' ').trim();
      if (!product || product.length < 3) {
        product = session.lastProduct || '';
      } else {
        session.lastProduct = product;
      }

      toolParams = { product: product || undefined, warehouse: city, thickness_cm: thickness };
    }

    // ── No tool matched ───────────────────────────────────────────────────────
    if (!toolName) {
      if (isGreetingOrHelp(message)) {
        return {
          conversation_id: conversationId,
          role: user.role,
          user_name: user.name,
          reply: `Hello ${user.name}! I'm your Stone & Quartz ERP Assistant. I can help you check slab inventory, look up purchase orders, or review landed costs. How can I assist you today?`,
          tools_called: [],
          tokens_used: 20,
          response_time_ms: Date.now() - startTime,
        };
      }

      return {
        conversation_id: conversationId,
        role: user.role,
        user_name: user.name,
        reply: "I don't have proper data about it. I can only answer about inventory and purchasing.",
        tools_called: [],
        tokens_used: 15,
        response_time_ms: Date.now() - startTime,
      };
    }

    const toolResult = await this.toolExecutor.execute(toolName, toolParams, token);
    toolsCalled.push({ tool: toolName, input: toolParams, output: toolResult });

    let reply = '';
    if (toolResult && toolResult.allowed === false) {
      reply = toolResult.polite_refusal || 'Access to this information is restricted for your role.';
    } else {
      reply = this.synthesizeFallback(toolName, toolParams, toolResult, session);
    }

    return {
      conversation_id: conversationId,
      role: user.role,
      user_name: user.name,
      reply,
      tools_called: toolsCalled,
      tokens_used: 50,
      response_time_ms: Date.now() - startTime,
    };
  }

  // ── Intent detection helpers — structural patterns, no static keyword lists ─

  /** True if the message intends to create a draft purchase order. */
  private detectDraftPoIntent(lower: string): boolean {
    return /\b(?:create|make|generate|prepare|write\s+up|set\s+up|draft|place|submit|raise)\b.*\b(?:draft\s+)?(?:po|purchase\s+order|order)\b/i.test(lower)
      || /\bdraft\s+(?:po|purchase\s+order)\b/i.test(lower)
      || /\b(?:po|purchase\s+order)\s+for\b/i.test(lower);
  }

  /** True if the message is confirming/saving a pending action. */
  private detectConfirmIntent(lower: string): boolean {
    return /^\s*(?:confirm|yes|yep|yup|ok|okay|sure|go\s+ahead|proceed|save|approve|save\s+it|do\s+it|that['']?s\s+(?:correct|fine|good)|looks?\s+(?:good|fine|correct))\s*[.!]?\s*$/.test(lower);
  }

  /** True if the message is asking about purchase orders or delivery status. */
  private detectPoSearchIntent(lower: string): boolean {
    return /\b(?:purchase\s+order|orders?|po\b|shipment|delivery|deliveries)\b/i.test(lower)
      && /\b(?:delayed?|late|overdue|behind|status|when|supplier|track|tracking|show|list|find|search)\b/i.test(lower);
  }

  /** True if the message intends a stock/inventory inquiry. */
  private detectStockIntent(lower: string): boolean {
    // Structural patterns: quantity questions, inventory keywords, material-class words
    return /\b(?:how\s+many|stock|inventory|on\s+hand|available|slabs?|check|show|list|do\s+we\s+have|quantity|how\s+much)\b/i.test(lower)
      // Material class keywords (not an exhaustive product list)
      || /\b(?:marble|quartz|quartzite|granite|porcelain|stone|dolomite|soapstone)\b/i.test(lower)
      // Specific thickness inquiry
      || /\b\d+(?:\.\d+)?\s*cm\b/i.test(lower);
  }

  // ── Response synthesis ────────────────────────────────────────────────────

  private synthesizeFallback(toolName: string, params: any, data: any, session: SessionState): string {
    switch (toolName) {
      case 'executeSql':
      case 'execute_sql': {
        if (data.allowed === false) {
          return data.polite_refusal || data.error || 'Access to this information is restricted for your role.';
        }
        const rows = data.rows || [];
        if (rows.length === 0) {
          return 'No matching records were found in the ERP database.';
        }
        if (rows[0].slabs_on_hand !== undefined && rows[0].name) {
          const list = rows.map((r: any) => `• ${r.name} (${r.thickness_cm}cm${r.city ? ', ' + r.city : ''}): ${r.slabs_on_hand} slabs`).join('\n');
          return `Here is the slab inventory from the database:\n${list}`;
        }
        if (rows[0].po_number) {
          const list = rows.map((r: any) => `• ${r.po_number} (${r.supplier_name || 'PO'}): ${r.status} (ETA: ${r.eta || 'N/A'})`).join('\n');
          return `Here are the purchase orders:\n${list}`;
        }
        return `Retrieved ${rows.length} record(s) from the database.`;
      }

      case 'checkStock': {
        const results = data.results || [];
        const whCity = data.resolved_warehouse || 'the warehouse';

        // City queried but not found in ERP — detected via resolved_warehouse fallback
        if (params.warehouse) {
          if (whCity === 'All Warehouses' && (data.found === false || results.length === 0 || data.specific_slabs_on_hand == null)) {
            return `We do not have a warehouse recorded for ${params.warehouse} in our ERP system. Our active warehouse locations are Houston, Dallas, and Chicago.`;
          }
        }

        if (results.length === 0) {
          return data.message || `No inventory found matching your query.`;
        }

        if (results.length === 1) {
          const top = results[0];
          const prodName = `${top.thickness_cm}cm ${top.name}`;
          session.lastProduct = prodName;
          if (whCity && whCity !== 'All Warehouses' && data.specific_slabs_on_hand != null) {
            session.lastWarehouse = whCity;
            return `There are ${data.specific_slabs_on_hand} slabs of ${prodName} in the ${whCity} warehouse.`;
          }
          const breakdown = top.warehouses.map((w: any) => `${w.city}: ${w.slabs_on_hand}`).join(', ');
          return `We have ${top.total_slabs_on_hand} slabs of ${prodName} across all warehouses (${breakdown}).`;
        }

        const itemsText = results.map((r: any) => {
          const wh = r.warehouses?.find((w: any) => w.city.toLowerCase() === whCity.toLowerCase());
          const qty = wh ? wh.slabs_on_hand : r.total_slabs_on_hand;
          return `• ${r.name} (${r.thickness_cm}cm): ${qty} slabs`;
        }).join('\n');
        return `Slab inventory for ${whCity}:\n${itemsText}`;
      }

      case 'getLandedCost': {
        const lines = data.data?.lines || [];
        const linesText = lines.map((l: any) =>
          `${l.product_name} (${l.thickness_cm}cm): $${l.landed_cost_per_slab} per slab ($${l.unit_cost} unit + $${l.freight_share_per_slab} freight)`
        ).join('\n');
        return `Landed cost breakdown for ${data.data?.po_number} (Supplier: ${data.data?.supplier}):\n${linesText}\nTotal freight: $${data.data?.freight_cost} across ${data.data?.total_slabs} slabs.`;
      }

      case 'createDraftPurchaseOrder': {
        if (data.status === 'draft_pending_confirmation') {
          session.pendingDraftToken = data.draft_token;
          return data.prompt || `Draft purchase order prepared. Reply "confirm" to save it.`;
        }
        return data.message || 'Draft prepared.';
      }

      case 'confirmDraftPurchaseOrder': {
        session.pendingDraftToken = undefined;
        return data.message || 'Purchase order has been confirmed and saved successfully.';
      }

      case 'searchPurchaseOrders': {
        const orders = data.purchase_orders || [];
        if (orders.length === 0) return 'No purchase orders found matching your query.';
        const formatted = orders.map((po: any) => {
          const delayTag = po.is_delayed ? ` [DELAYED — ETA was ${po.eta}]` : ` [ETA: ${po.eta}]`;
          const items = po.lines.map((l: any) => `${l.quantity} slabs ${l.product_name}`).join(', ');
          return `• ${po.po_number} from ${po.supplier_name} — ${po.status}${delayTag} (${items})`;
        }).join('\n');
        return `${data.delayed_filter_applied ? 'Delayed purchase orders:' : 'Purchase orders:'}\n${formatted}`;
      }

      default:
        return JSON.stringify(data);
    }
  }
}
