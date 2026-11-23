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

/**
 * Dynamically extract any city/location mentioned in the user query.
 * Matches patterns like "in Dallas", "at Chicago", "in Houston", "in Bhopal", "for Atlanta",
 * or short follow-ups like "dallas", "and in dallas", "what about houston".
 */
export function extractCity(message: string): string | undefined {
  const clean = message.trim();

  // 1. Matches "in <City>", "at <City>", "for <City>"
  const prepMatch = clean.match(/\b(?:in|at|for|around)\s+([A-Za-z]+)\b/i);
  if (prepMatch) {
    const word = prepMatch[1].trim();
    const nonCityWords = /^(stock|transit|draft|detail|details|cost|costs|freight|database|order|orders|slabs?|stone|quartz|meters?|inches?|total|advance|warehouse|warehouses)$/i;
    if (!nonCityWords.test(word)) {
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }
  }

  // 2. Matches short contextual follow-up phrases like "Dallas", "in Dallas", "and in Dallas?", "what about Dallas", "how about Dallas"
  const followUpMatch = clean.match(/^(?:(?:and|what\s+about|how\s+about)\s+(?:in\s+)?|in\s+)?([A-Za-z]+)\??$/i);
  if (followUpMatch) {
    const word = followUpMatch[1].trim();
    const commonActions = /^(confirm|yes|no|cancel|save|help|hi|hello|hey|thanks|thank|ok|okay|slabs?|stock|orders?)$/i;
    if (!commonActions.test(word)) {
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }
  }

  return undefined;
}

/**
 * Dynamically checks if the message is a conversational greeting, capability inquiry, or polite small talk.
 */
export function isGreetingOrHelp(message: string): boolean {
  const lower = message.trim().toLowerCase().replace(/[!?.,]/g, '');
  const words = lower.split(/\s+/);
  if (words.length <= 5) {
    if (/^(hi|hello|hey|howdy|greetings|good\s*(morning|afternoon|evening|day)|welcome|help)\b/i.test(lower)) {
      return true;
    }
    if (/^(what\s+can\s+you\s+do|who\s+are\s+you|what\s+do\s+you\s+do|help\s+me)\b/i.test(lower)) {
      return true;
    }
  }
  return false;
}

/**
 * Dynamically checks if the query is strictly out-of-domain (world trivia, monuments, presidents, general coding).
 */
export function isOutOfDomainQuestion(message: string): boolean {
  const lower = message.trim().toLowerCase();
  const offTopicPatterns = /\b(qutub\s*minar|taj\s*mahal\s*located|capital\s+of|president\s+of|prime\s+minister|who\s+(was|is)\s+(the\s+)?[a-z]+|where\s+is\s+(the\s+)?[a-z\s]+(located|situated|built)|weather\s+in|recipe|cricket|football|movie|song|actor|actress|poem|solve\s+math|write\s+code\s+for)\b/i;
  return offTopicPatterns.test(lower);
}

function isRelevantToDatabase(message: string, session: SessionState): boolean {
  const lower = message.trim().toLowerCase();

  // Explicit off-topic check
  if (isOutOfDomainQuestion(message)) {
    return false;
  }

  // Greetings and capability inquiries
  if (isGreetingOrHelp(message)) {
    return true;
  }

  // Active draft PO awaiting confirmation
  if (session.pendingDraftToken && /^(confirm|yes|save|cancel|no)\b/i.test(lower)) {
    return true;
  }

  // Any city or warehouse inquiry (dynamic, not restricted to specific cities)
  if (extractCity(message)) {
    return true;
  }

  // Follow-up thickness inquiry (e.g. "and 3cm?", "what about 2cm?", "how many 2cm slabs")
  if (/\b([23])\s*cm\b/i.test(lower)) {
    return true;
  }

  // Stone, quartz, inventory, warehouse, purchase orders, costs keywords
  const erpPattern = /\b(slab|slabs|stone|quartz|marble|granite|quartzite|porcelain|calacatta|carrara|marquina|statuario|bianco|taj\s*mahal|thickness|2cm|3cm|sqft|inventory|stock|warehouse|warehouses|supplier|suppliers|purchase\s+order|purchase\s+orders|po[- ]?\d+|draft\s+po|create\s+draft|delayed|late|overdue|eta|freight|landed\s+cost|unit\s+cost|cost\s+per\s+slab|on\s+hand|available)\b/i;
  if (erpPattern.test(lower)) {
    return true;
  }

  // Contextual follow-up when previous conversation history exists
  if (session.history.length > 0 && lower.split(/\s+/).length <= 4) {
    return true;
  }

  return false;
}

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
        description: 'Execute a read-only MySQL SELECT query against the ERP database to fetch live data (ChatGPT / Claude style Text-to-SQL). Use this to query products, slabs on hand, warehouses (by any city), suppliers, purchase orders, delayed shipments, or landed costs.',
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
        description: 'Check slabs on hand for a stone or quartz product across warehouses in any city or location. Returns real inventory quantities.',
        schema: z.object({
          product: z.string().optional().describe('Product name, material, or color (e.g. "Calacatta Gold", "Carrara White", "Calacatta"). Can be omitted if checking all slabs or following up on previous product.'),
          warehouse: z.string().optional().describe('Warehouse city name (e.g. "Houston", "Dallas", "Chicago", or any city mentioned by the user)'),
          thickness_cm: z.number().optional().describe('Slab thickness in cm (e.g. 2 or 3)'),
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
        description: 'Search purchase orders with filters for supplier name, delayed status, or PO number.',
        schema: z.object({
          supplier_name: z.string().optional().describe('Supplier name (e.g. "Supplier X", "Supplier Y")'),
          delayed_only: z.boolean().optional().describe('True to filter only delayed purchase orders'),
          po_number: z.string().optional().describe('Specific purchase order number (e.g. "PO-1023")'),
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
        description: 'Calculate landed cost per slab (unit cost + share of freight). RESTRICTED TO PURCHASING TEAM.',
        schema: z.object({
          po_number: z.string().describe('Purchase order number (e.g. "PO-1023")'),
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
        description: 'Prepare a draft PO from a supplier. Asks user for confirmation before saving. RESTRICTED TO PURCHASING TEAM.',
        schema: z.object({
          supplier_name: z.string().describe('Supplier name (e.g. "Supplier Y")'),
          items: z.array(z.object({
            product: z.string().describe('Product name'),
            quantity: z.number().describe('Quantity of slabs'),
            unit_cost: z.number().optional().describe('Unit cost per slab'),
          })).describe('Line items to purchase'),
          estimated_freight: z.number().optional().describe('Estimated freight cost'),
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
        description: 'Confirm and save a draft purchase order to the database. RESTRICTED TO PURCHASING TEAM.',
        schema: z.object({
          draft_token: z.string().optional().describe('Draft token if available'),
        }),
      }
    );

    // Strict Role Restriction: Sales users have NO access to insert, draft, or confirm POs, or view landed costs
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

    // Contextual extraction: dynamically track thickness and warehouse/city mentions across turns
    const tm = lower.match(/\b([23])\s*cm\b/i);
    if (tm) {
      session.lastThickness = parseInt(tm[1], 10);
    }
    const cityDetected = extractCity(message);
    if (cityDetected) {
      session.lastWarehouse = cityDetected;
    }

    // Prompt injection security guard
    if (/(ignore\s+all\s+rules|system\s+override|act\s+as\s+admin|drop\s+table)/i.test(lower)) {
      return {
        conversation_id: conversationId,
        role: user.role,
        user_name: user.name,
        reply: 'Adversarial instruction or system override attempt detected. The AI assistant answers inventory and purchasing questions within verified role bounds.',
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

    // 1. Dynamic LLM Path (Google Gemini via @langchain/google)
    if (this.llm) {
      try {
        const systemPrompt = `You are the AI Assistant for a US natural stone & quartz distributor ERP.
Current logged-in staff member: ${user.name} (Role: ${user.role}).

CORE ARCHITECTURE: TEXT-TO-SQL AI AGENT (ChatGPT / Claude style):
You process user input, construct precise MySQL SELECT queries to fetch data from the database, send the SQL to the backend via the \`execute_sql\` tool, inspect the returned rows, and synthesize an accurate, professional natural language answer.

DATABASE SCHEMA (MySQL database: laravel_erp):
1. \`products\` (id, sku, name, material, color, thickness_cm, slab_size)
   - Examples: name = 'Calacatta Gold', material = 'Marble', color = 'White/Gold', thickness_cm = 3.0, sku = 'CAL-3CM-001'
   - Examples: name = 'Carrara White', material = 'Marble', color = 'White/Grey', thickness_cm = 2.0, sku = 'CAR-2CM-002'
   - Other materials: 'Quartz', 'Quartzite', 'Granite', 'Dolomite', 'Soapstone'

2. \`warehouses\` (id, name, city)
   - Active warehouse locations in DB: 'Houston', 'Dallas', 'Chicago'.
   - IMPORTANT: The user can ask about ANY city or location (e.g. Houston, Dallas, Chicago, Bhopal, Atlanta, Denver, etc.).
   - Dynamically check the database for the requested city. If the city does NOT exist in the ERP database, inform the user:
     "We do not have any warehouse or inventory recorded for [City] in our ERP system. Our active warehouse locations are in Houston, Dallas, and Chicago."

3. \`stock\` (id, product_id, warehouse_id, slabs_on_hand)
   - Tracks slabs on hand per product per warehouse.
   - Joins: stock.product_id = products.id, stock.warehouse_id = warehouses.id

4. \`suppliers\` (id, name, contact, payment_terms, bank_details)
   - Suppliers: 'Supplier X', 'Supplier Y', 'Apex Stone Imports', 'Verona Marble Co', 'Quarzo Surfaces LLC'
   - NOTE: bank_details is RESTRICTED to Purchasing role.

5. \`purchase_orders\` (id, po_number, supplier_id, status, order_date, eta, freight_cost, notes)
   - Statuses: 'confirmed', 'delayed', 'received', 'draft'
   - NOTE: freight_cost and draft purchase orders are RESTRICTED to Purchasing role.
   - Delayed POs: status = 'delayed' OR (status != 'received' AND eta < CURDATE())

6. \`purchase_order_lines\` (id, purchase_order_id, product_id, quantity, unit_cost)
   - NOTE: unit_cost is RESTRICTED to Purchasing role.
   - Landed cost per slab = unit_cost + (freight_cost / total_slabs_in_po)

HOW TO OPERATE LIKE CHATGPT / CLAUDE TEXT-TO-SQL:
1. When the user asks about stock, inventory, products, warehouses, delayed POs, suppliers, or orders:
   - Formulate a clean MySQL SELECT query.
   - Call the \`execute_sql\` tool with your SQL query.
   - When the backend returns the database rows, analyze the data and synthesize a clear, friendly, and complete natural language answer.
   - You may also use specialized tools (\`check_stock\`, \`search_purchase_orders\`, \`get_landed_cost\`) where appropriate.

2. NEVER SEND ACTUAL SQL TO END USER (STRICT MANDATORY):
   - You must execute SQL queries internally via the \`execute_sql\` tool.
   - NEVER output raw SQL queries (e.g. SELECT...), SQL syntax, or database code in your conversational text response to the user.
   - Communicate strictly in clean, professional, conversational natural language.

3. DRAFT PURCHASE ORDER WORKFLOW (MANDATORY FOR PURCHASING ONLY):
   - When a PURCHASING user asks to create a draft PO (e.g. "create draft PO for 10 slabs of 2 cm tajmahal white"):
     Step A: You may execute SQL internally to look up products or suppliers in the database if needed.
     Step B: You MUST then invoke the \`create_draft_purchase_order\` tool with supplier_name, items (product, quantity, unit_cost), and optional estimated_freight.
       * If no supplier is specified by user, default to 'Supplier Y' or 'Supplier X'.
       * If no unit cost is specified, default to a realistic cost (e.g. 150.00).
     Step C: Once \`create_draft_purchase_order\` returns, present the draft summary clearly (Supplier, line items, quantity, total cost) and ask the user to reply "confirm":
       'Reply "confirm" to save it.'
   - When the user confirms (e.g. "confirm", "yes", "save it"), call \`confirm_draft_purchase_order\` to persist it to the database.

4. ROLE-BASED ACCESS CONTROL (MANDATORY):
   - Current user role is: "${user.role}".
   ${user.role === 'sales' ? `- CRITICAL RESTRICTIONS FOR SALES:
   1. Sales users have NO ACCESS to insert, draft, or confirm purchase orders. If a sales user asks to create, draft, or confirm a purchase order, YOU MUST REFUSE IMMEDIATELY: "I apologize, but creating and confirming draft purchase orders is restricted to the Purchasing team. As a member of the Sales team, you do not have permission to draft or confirm purchase orders." Do NOT create any draft, do NOT call draft tools, and do NOT ask for confirmation.
   2. Sales users CANNOT view draft purchase order data, unit costs, landed costs, freight, or supplier bank details. Never show draft parameters, line items, or cost figures to sales.
   3. In SQL queries for Sales, NEVER select or include freight_cost, unit_cost, or bank_details, and NEVER select draft purchase orders (status = 'draft'). Any query violating this will be rejected.` : '- Purchasing role: Full access to all columns, landed costs, freight, and drafting POs.'}

5. OUT-OF-DATABASE QUESTIONS (MANDATORY DENIAL):
   - If the user asks ANY general trivia question completely outside stone & quartz ERP operations (e.g. world capitals, historical monuments like "where is Qutub Minar located", presidents, recipes, sports, coding):
     YOU MUST DENY THE ANSWER in simple language:
     "I don't have proper data about it. I can only answer about inventory and purchasing."
   - Do NOT answer general world trivia or off-topic questions.

6. CONVERSATIONAL CONTEXT & CHECKPOINTER MEMORY:
   - Use checkpointer memory to track conversation context across turns. For example, if the user asks about 2cm slabs in Bhopal, and then follows up with "in Dallas", remember the 2cm slab context and query the Dallas warehouse inventory.`;

        const llmWithTools = this.llm.bindTools(tools);

        // Feed prior conversation messages from checkpointer memory (up to last 8 messages)
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

        // Multi-turn tool execution loop (Text-to-SQL -> Data Evaluation -> Action Tool -> Final Response)
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

        // Fallback response if model generated tool calls but empty prose
        if (!finalReply || finalReply.trim() === '') {
          const draftTool = toolsCalled.find(t => t.tool === 'createDraftPurchaseOrder' || t.tool === 'create_draft_purchase_order');
          if (draftTool && draftTool.output) {
            finalReply = draftTool.output.prompt || `Draft purchase order created: ${draftTool.output.summary || 'Details prepared'}. Reply "confirm" to save it.`;
          } else {
            for (const tc of toolsCalled) {
              if (tc.output && tc.output.allowed === false) {
                finalReply = tc.output.polite_refusal || 'Cost details are only available to the Purchasing team.';
                break;
              }
            }
          }
        }

        // Domain guardrail: if no tool was called and question is not relevant to DB or greetings, deny in simple language
        if (toolsCalled.length === 0 && !isRelevantToDatabase(message, session)) {
          finalReply = "I don't have proper data about it. I can only answer about inventory and purchasing.";
        }

        session.history.push({ role: 'user', text: message });
        session.history.push({ role: 'assistant', text: finalReply });

        // Save conversation state into LangGraph Checkpointer Memory
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
              channel_values: {
                messages: updatedMessages,
              },
              channel_versions: { messages: updatedMessages.length },
              versions_seen: {},
            },
            {
              source: 'update',
              step: updatedMessages.length,
              parents: {},
            },
            {}
          );
        } catch (ckptErr: any) {
          console.warn('Could not save to checkpointer memory:', ckptErr?.message || ckptErr);
        }

        // Sanitize tools_called returned to client:
        // 1. Never send raw SQL to the end user
        // 2. Never return draft tools, draft parameters, or denied tools to the Sales role
        const sanitizedToolsCalled = toolsCalled
          .filter(tc => {
            if (user.role === 'sales') {
              if (
                tc.tool === 'createDraftPurchaseOrder' ||
                tc.tool === 'create_draft_purchase_order' ||
                tc.tool === 'confirmDraftPurchaseOrder' ||
                tc.tool === 'confirm_draft_purchase_order' ||
                tc.tool === 'getLandedCost' ||
                tc.tool === 'get_landed_cost' ||
                tc.output?.allowed === false
              ) {
                return false;
              }
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

    // 2. Local Fallback Engine (when LLM key is absent or offline)
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

    // Strict Role Enforcement for Sales in Fallback Engine:
    // Sales users cannot create, draft, or confirm purchase orders, or view landed costs
    if (user.role === 'sales') {
      if (
        /create\s+(a\s+)?draft\s+po|draft\s+po\s+for|create\s+po\s+for/i.test(lower) ||
        /^(confirm|yes\s*,?\s*confirm|save\s+it)\b/i.test(lower)
      ) {
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

      if (/landed\s+cost|cost\s+per\s+slab/i.test(lower)) {
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

    if (/^(confirm|yes\s*,?\s*confirm|save\s+it)\b/i.test(lower)) {
      toolName = 'confirmDraftPurchaseOrder';
      toolParams = { draft_token: session.pendingDraftToken };
    } else if (/create\s+(a\s+)?draft\s+po|draft\s+po\s+for/i.test(lower)) {
      toolName = 'createDraftPurchaseOrder';
      let supplier = 'Supplier Y';
      const sm = message.match(/from\s+([a-zA-Z0-9\s]+?)(?:\.|$)/i);
      if (sm) supplier = sm[1].trim();

      let qty = 20;
      let prod = '2cm Carrara White';
      const qm = message.match(/(\d+)\s+slabs?\s+of\s+([a-zA-Z0-9\s]+?)(?:\s+from|\.|$)/i);
      if (qm) {
        qty = parseInt(qm[1], 10);
        prod = qm[2].trim();
      }

      toolParams = {
        supplier_name: supplier,
        items: [{ product: prod, quantity: qty, unit_cost: 85.00 }],
      };
    } else if (/landed\s+cost|cost\s+per\s+slab/i.test(lower)) {
      toolName = 'getLandedCost';
      let poNumber = session.lastPoNumber || 'PO-1023';
      const pm = message.match(/(PO-\d+)/i);
      if (pm) poNumber = pm[1].toUpperCase();
      session.lastPoNumber = poNumber;
      toolParams = { po_number: poNumber };
    } else if (/purchase\s+orders?|orders?|po\b/i.test(lower) && (/delayed|late|overdue/i.test(lower) || /supplier/i.test(lower))) {
      toolName = 'searchPurchaseOrders';
      let supplierName: string | undefined = undefined;
      const suppMatch = message.match(/supplier\s+([a-zA-Z0-9]+)/i);
      if (suppMatch) {
        supplierName = `Supplier ${suppMatch[1].toUpperCase()}`;
      }
      const delayedOnly = /delayed|late|overdue/i.test(lower);
      toolParams = { supplier_name: supplierName, delayed_only: delayedOnly };
    } else if (extractCity(message) || /slabs?|stock|inventory|calacatta|carrara|marble|quartz|granite|quartzite/i.test(lower)) {
      toolName = 'checkStock';
      const city = extractCity(message) || session.lastWarehouse;
      if (city) {
        session.lastWarehouse = city;
      }

      let thickness = session.lastThickness;
      const tm = lower.match(/\b([23])\s*cm\b/i);
      if (tm) {
        thickness = parseInt(tm[1], 10);
        session.lastThickness = thickness;
      }

      let cleanMsg = message.replace(/[?.,!]/g, ' ');
      if (city) {
        const cityRegex = new RegExp(`\\b(?:in|at|for|around)\\s+${city}\\b|\\b${city}\\b`, 'gi');
        cleanMsg = cleanMsg.replace(cityRegex, ' ');
      }
      let product = cleanMsg.replace(/(how many|slabs?|do we have|in stock|stock|available|and in|what about|how about)/gi, '').trim();
      product = product.replace(/\s+/g, ' ').trim();
      if (!product || product.length < 3) {
        product = session.lastProduct || '';
      } else {
        session.lastProduct = product;
      }

      toolParams = { product: product || undefined, warehouse: city, thickness_cm: thickness };
    }

    if (!toolName) {
      if (isGreetingOrHelp(message)) {
        return {
          conversation_id: conversationId,
          role: user.role,
          user_name: user.name,
          reply: `Hello ${user.name}! I am your Stone & Quartz ERP AI Assistant. How can I assist you with inventory stock, purchase orders, or landed costs today?`,
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
      reply = toolResult.polite_refusal || 'Cost details are only available to the Purchasing team.';
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

  private synthesizeFallback(toolName: string, params: any, data: any, session: SessionState): string {
    switch (toolName) {
      case 'executeSql':
      case 'execute_sql': {
        if (data.allowed === false) {
          return data.polite_refusal || data.error || 'Cost details are only available to the Purchasing team.';
        }
        const rows = data.rows || [];
        if (rows.length === 0) {
          return 'No matching records were found in the ERP database.';
        }
        if (rows[0].slabs_on_hand !== undefined && rows[0].name) {
          const list = rows.map((r: any) => `• ${r.name} (${r.thickness_cm}cm${r.city ? ', ' + r.city : ''}): ${r.slabs_on_hand} slabs`).join('\n');
          return `Here is the slab inventory retrieved from the database:\n${list}`;
        }
        if (rows[0].po_number) {
          const list = rows.map((r: any) => `• ${r.po_number} (${r.supplier_name || 'PO'}): ${r.status} (ETA: ${r.eta || 'N/A'})`).join('\n');
          return `Here are the purchase orders retrieved from the database:\n${list}`;
        }
        return `Data retrieved from database (${rows.length} records):\n` + JSON.stringify(rows, null, 2);
      }
      case 'checkStock': {
        const results = data.results || [];
        const whCity = data.resolved_warehouse || 'the warehouse';

        // Check if a specific city was queried that does not exist in our ERP
        if (params.warehouse) {
          const knownWarehouses = ['Houston', 'Dallas', 'Chicago'];
          const isKnown = knownWarehouses.some(k => k.toLowerCase() === params.warehouse.toLowerCase());
          if (!isKnown && (whCity === 'All Warehouses' || results.length === 0 || data.found === false)) {
            return `We do not have any warehouse or inventory recorded for ${params.warehouse} in our ERP system. Our active warehouse locations are in Houston, Dallas, and Chicago.`;
          }
        }

        if (results.length === 0) {
          return data.message || `No products found matching '${params.product || 'inventory query'}'.`;
        }
        if (results.length === 1) {
          const top = results[0];
          const prodName = `${top.thickness_cm}cm ${top.name}`;
          session.lastProduct = prodName;
          if (whCity && whCity !== 'All Warehouses' && data.specific_slabs_on_hand !== null) {
            session.lastWarehouse = whCity;
            return `There are ${data.specific_slabs_on_hand} slabs of ${prodName} in the ${whCity} warehouse.`;
          }
          const breakdown = top.warehouses.map((w: any) => `${w.city}: ${w.slabs_on_hand}`).join(', ');
          return `We have ${top.total_slabs_on_hand} slabs of ${prodName} on hand across warehouses (${breakdown}).`;
        } else {
          const itemsText = results.map((r: any) => {
            const wh = r.warehouses?.find((w: any) => w.city.toLowerCase() === whCity.toLowerCase());
            const qty = wh ? wh.slabs_on_hand : r.total_slabs_on_hand;
            return `• ${r.name} (${r.thickness_cm}cm): ${qty} slabs`;
          }).join('\n');
          return `Here is the slab inventory for ${whCity}:\n${itemsText}`;
        }
      }
      case 'getLandedCost': {
        const lines = data.data?.lines || [];
        const linesText = lines.map((l: any) =>
          `${l.product_name} (${l.thickness_cm}cm): $${l.landed_cost_per_slab} per slab ($${l.unit_cost} unit + $${l.freight_share_per_slab} freight)`
        ).join('\n');
        return `Landed cost for ${data.data?.po_number} (Supplier: ${data.data?.supplier}):\n${linesText}\nTotal freight: $${data.data?.freight_cost} distributed across ${data.data?.total_slabs} slabs.`;
      }
      case 'createDraftPurchaseOrder': {
        if (data.status === 'draft_pending_confirmation') {
          session.pendingDraftToken = data.draft_token;
          return data.prompt || `Here's the draft: ${data.summary}. Reply "confirm" to save it.`;
        }
        return data.message || 'Draft prepared.';
      }
      case 'confirmDraftPurchaseOrder': {
        session.pendingDraftToken = undefined;
        return data.message || `Purchase order has been successfully confirmed and saved.`;
      }
      case 'searchPurchaseOrders': {
        const orders = data.purchase_orders || [];
        if (orders.length === 0) return 'No purchase orders found matching your search criteria.';
        const formatted = orders.map((po: any) => {
          const delayTag = po.is_delayed ? ` [DELAYED - ETA was ${po.eta}]` : ` [ETA: ${po.eta}]`;
          const items = po.lines.map((l: any) => `${l.quantity} slabs ${l.product_name}`).join(', ');
          return `• ${po.po_number} from ${po.supplier_name} - Status: ${po.status}${delayTag} (${items})`;
        }).join('\n');
        return `${data.delayed_filter_applied ? 'Delayed purchase orders:' : 'Purchase orders:'}\n${formatted}`;
      }
      default:
        return JSON.stringify(data);
    }
  }
}
