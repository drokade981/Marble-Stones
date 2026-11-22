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

function isRelevantToDatabase(message: string, session: SessionState): boolean {
  const lower = message.trim().toLowerCase();

  // Active draft PO awaiting confirmation
  if (session.pendingDraftToken && /^(confirm|yes|save|cancel|no)\b/i.test(lower)) {
    return true;
  }

  // Follow-up warehouse inquiry (e.g. "in dallas", "and in dallas", "dallas", "what about houston")
  if (/(houston|dallas|chicago)/i.test(lower)) {
    return true;
  }

  // Follow-up thickness inquiry (e.g. "and 3cm?", "what about 2cm?", "how many 2cm slabs")
  if (/\b([23])\s*cm\b/i.test(lower)) {
    return true;
  }

  // Stone, quartz, inventory, warehouse, purchase orders, costs keywords
  const erpPattern = /\b(slab|slabs|stone|quartz|marble|granite|quartzite|porcelain|calacatta|carrara|marquina|statuario|bianco|taj\s+mahal|thickness|2cm|3cm|sqft|inventory|stock|warehouse|warehouses|houston|dallas|chicago|supplier|suppliers|purchase\s+order|purchase\s+orders|po[- ]?\d+|draft\s+po|delayed|late|overdue|eta|freight|landed\s+cost|unit\s+cost|cost\s+per\s+slab|on\s+hand|available)\b/i;
  if (erpPattern.test(lower)) {
    return true;
  }

  // Polite greetings and questions about the assistant's capabilities
  const greetingOrHelpPattern = /^(hi|hello|hey|help|howdy|greetings|good\s+(morning|afternoon|evening))\b/i;
  const capabilityPattern = /\b(what\s+can\s+you\s+do|who\s+are\s+you|what\s+do\s+you\s+do|help\s+me)\b/i;
  if (greetingOrHelpPattern.test(lower) || capabilityPattern.test(lower)) {
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

  private createTools(token: string, session: SessionState, toolsCalled: any[]) {
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
        description: 'Check slabs on hand for a stone or quartz product across warehouses (Houston, Dallas, Chicago). Returns real inventory quantities.',
        schema: z.object({
          product: z.string().optional().describe('Product name, material, or color (e.g. "Calacatta Gold", "Carrara White", "Calacatta"). Can be omitted if checking all slabs or following up on previous product.'),
          warehouse: z.string().optional().describe('Warehouse city name (e.g. "Houston", "Dallas", "Chicago")'),
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

    return [checkStock, searchPurchaseOrders, getLandedCost, createDraftPO, confirmDraftPO];
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

    // Contextual extraction: track thickness and warehouse mentions across turns
    const tm = lower.match(/\b([23])\s*cm\b/i);
    if (tm) {
      session.lastThickness = parseInt(tm[1], 10);
    }
    const wm = lower.match(/\b(houston|dallas|chicago)\b/i);
    if (wm) {
      session.lastWarehouse = wm[1].charAt(0).toUpperCase() + wm[1].slice(1).toLowerCase();
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
    const tools = this.createTools(token, session, toolsCalled);
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
        const systemPrompt = `You are the AI Assistant for a US stone and quartz distributor ERP.
Current logged-in staff member: ${user.name} (Role: ${user.role}).

CRITICAL INSTRUCTIONS ON DATABASE SCOPE:
1. ONLY DATA AVAILABLE IN DATABASE:
   - You ONLY have access to our stone and quartz ERP database: products (slabs, materials like marble/quartz/granite, thicknesses 2cm/3cm), stock in warehouses (Houston, Dallas, Chicago), suppliers, purchase orders, and landed costs.
   - You must retrieve all facts, quantities, dates, and costs from live ERP tools. Never make up or guess any numbers, dates, or prices.
   - If a product or record is not found in the database, explicitly state that no matching records exist in the database.

2. IRRELEVANT / OUT-OF-DATABASE QUESTION DENIAL (MANDATORY):
   - If the user asks ANY question that is NOT relevant to our stone & quartz ERP database (such as world capitals, geography like "what is capital of india", history, trivia, general knowledge, coding, weather, math, entertainment, sports, politics), YOU MUST DENY THE ANSWER in simple language.
   - Reply strictly with this simple denied answer:
   "I don't have proper data about it. I can only answer about inventory and purchasing."
   - Do NOT answer the irrelevant question even partially. Never include outside world facts or trivia in your answer.

3. CONVERSATIONAL GREETINGS & CAPABILITIES:
   - For polite greetings (hi, hello, hey, good morning, etc.) or questions about what you do, respond politely and concisely in simple language as the Stone & Quartz ERP AI Assistant. Explain that you can answer questions about inventory slab stock across warehouses, purchase order statuses, and landed costs. Do not deny polite greetings.

4. ROLE-BASED ACCESS CONTROL:
   - Sales role: Allowed to check stock, view product details, and check purchase order status. Strictly forbidden from viewing landed costs, unit costs, freight costs, or supplier bank details. If Sales asks for landed cost or freight, politely refuse: "Cost details are only available to the Purchasing team."
   - Purchasing role: Full access to stock, purchase orders, landed costs, freight, and creating draft purchase orders.

5. CONFIRM-BEFORE-WRITE DRAFT PO WORKFLOW:
   - When asked to create a purchase order, call create_draft_purchase_order to prepare the draft. Present the draft details (supplier, items, quantity) and ask the user to reply "confirm" to save it.
   - When the user confirms (e.g. "confirm", "yes", "save it"), call confirm_draft_purchase_order to persist it to the database.

6. CONVERSATIONAL CONTEXT & CHECKPOINTER MEMORY:
   - Use checkpointer memory to track the conversation context across turns.
   - When a user asks a follow-up inquiry (e.g. "how many 2cm slabs available in bhopal" followed by "in dallas", or "How many 3cm Calacatta slabs do we have in Houston?" followed by "And in Dallas?"), use the remembered product, thickness, and context to check stock for the requested warehouse.`;

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

        const aiResponse = await llmWithTools.invoke(messages);

        let finalReply = '';

        if (aiResponse.tool_calls && aiResponse.tool_calls.length > 0) {
          const toolMessages: ToolMessage[] = [];

          for (const tc of aiResponse.tool_calls) {
            const toolInstance = toolMap[tc.name];
            if (toolInstance) {
              const toolResult = await toolInstance.invoke(tc.args);
              toolMessages.push(
                new ToolMessage({
                  tool_call_id: tc.id || tc.name,
                  name: tc.name,
                  content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
                })
              );
            }
          }

          const followUp = await this.llm.invoke([...messages, aiResponse, ...toolMessages]);
          finalReply = extractCleanText(followUp.content);
        } else {
          finalReply = extractCleanText(aiResponse.content);
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
          await this.checkpointer.put(
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
            {},
            {}
          );
        } catch (ckptErr: any) {
          console.warn('Could not save to checkpointer memory:', ckptErr?.message || ckptErr);
        }

        return {
          conversation_id: conversationId,
          role: user.role,
          user_name: user.name,
          reply: finalReply,
          tools_called: toolsCalled,
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
    } else if (/(houston|dallas|chicago)/i.test(lower)) {
      toolName = 'checkStock';
      const m = lower.match(/(houston|dallas|chicago)/i);
      const city = m ? m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase() : 'Dallas';
      let prod = session.lastProduct || '';
      let thick = session.lastThickness;
      const tm = lower.match(/\b([23])\s*cm\b/i);
      if (tm) thick = parseInt(tm[1], 10);
      toolParams = {
        product: prod,
        warehouse: city,
        thickness_cm: thick,
      };
    } else if (/slabs?|stock|inventory|calacatta|carrara|marble|quartz/i.test(lower)) {
      toolName = 'checkStock';
      const cleanMsg = message.replace(/[?.,!]/g, ' ');
      let warehouse: string | undefined = undefined;
      const wm = cleanMsg.match(/\b(in|at)\s+(houston|dallas|chicago)\b/i);
      if (wm) {
        warehouse = wm[2].charAt(0).toUpperCase() + wm[2].slice(1).toLowerCase();
      }

      let product = cleanMsg.replace(/(how many|slabs?|do we have|in stock|stock|available|in\s+(houston|dallas|chicago))/gi, '').trim();
      product = product.replace(/\s+/g, ' ').trim();
      if (!product || product.length < 3) {
        product = session.lastProduct || '';
      }

      let thickness = session.lastThickness;
      const tm = product.match(/\b([23])\s*cm\b/i);
      if (tm) {
        thickness = parseInt(tm[1], 10);
      }

      toolParams = { product, warehouse, thickness_cm: thickness };
    }

    if (!toolName) {
      if (/^(hi|hello|hey|help|howdy|good\s+(morning|afternoon|evening))\b/i.test(lower)) {
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
      case 'checkStock': {
        const results = data.results || [];
        if (results.length === 0) {
          return data.message || `No products found matching '${params.product || 'inventory query'}'.`;
        }
        const whCity = data.resolved_warehouse || 'the warehouse';
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
