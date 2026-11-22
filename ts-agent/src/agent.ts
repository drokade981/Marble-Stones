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
    const executeSql = tool(
      async ({ sql }) => {
        const result = await this.erpClient.executeSql(token, sql);
        toolsCalled.push({ tool: 'execute_sql', input: { sql }, output: result });
        return JSON.stringify(result);
      },
      {
        name: 'execute_sql',
        description: 'Execute a read-only MySQL SELECT query against the ERP database to fetch live data (ChatGPT / Claude style Text-to-SQL). Use this to query products, slabs on hand, warehouses, suppliers, purchase orders, delayed shipments, or landed costs.',
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
   - Cities: 'Houston', 'Dallas', 'Chicago'

3. \`stock\` (id, product_id, warehouse_id, slabs_on_hand)
   - Tracks slabs on hand per product per warehouse.
   - Joins: stock.product_id = products.id, stock.warehouse_id = warehouses.id

4. \`suppliers\` (id, name, contact, payment_terms, bank_details)
   - Suppliers: 'Supplier X', 'Supplier Y', 'Apex Stone Imports', 'Verona Marble Co', 'Quarzo Surfaces LLC'
   - NOTE: bank_details is RESTRICTED to Purchasing role.

5. \`purchase_orders\` (id, po_number, supplier_id, status, order_date, eta, freight_cost, notes)
   - Statuses: 'confirmed', 'delayed', 'received', 'draft'
   - NOTE: freight_cost is RESTRICTED to Purchasing role.
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

2. ROLE-BASED ACCESS CONTROL (MANDATORY):
   - Current user role is: "${user.role}".
   ${user.role === 'sales' ? '- CRITICAL RESTRICTION FOR SALES: Because this user is in the SALES role, you MUST NEVER select or include `freight_cost`, `unit_cost`, or `bank_details` in your SQL queries! Any query containing these columns will be rejected by the server. When checking purchase orders or delayed orders for Sales, select ONLY `po.po_number`, `po.status`, `po.order_date`, `po.eta`, `s.name as supplier_name`, and `p.name as product_name`. If Sales asks for landed cost, unit cost, or freight, politely refuse: "Cost details are only available to the Purchasing team."' : '- Purchasing role: Full access to all columns, landed costs, freight, and drafting POs.'}

3. DRAFT PO WORKFLOW:
   - When asked to create a draft PO, use \`create_draft_purchase_order\` to prepare the draft and prompt the user to reply "confirm".
   - When confirmed, use \`confirm_draft_purchase_order\` to save it.

4. OUT-OF-DATABASE QUESTIONS (MANDATORY DENIAL):
   - If the user asks ANY question not relevant to our stone & quartz ERP database (e.g. world capitals, general trivia, history, programming, cities not in our ERP like "bhopal", etc.), YOU MUST DENY THE ANSWER in simple language:
   "I don't have proper data about it. I can only answer about inventory and purchasing."
   - Do NOT execute queries for non-ERP questions and never provide outside world facts.

5. CONVERSATIONAL CONTEXT & CHECKPOINTER MEMORY:
   - Use checkpointer memory to track the conversation context across turns (e.g. remembering 2cm thickness or a specific product across follow-ups like "in dallas").`;

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

          if (!finalReply || finalReply.trim() === '') {
            for (const tc of toolsCalled) {
              if (tc.output && tc.output.allowed === false) {
                finalReply = tc.output.polite_refusal || 'Cost details are only available to the Purchasing team.';
                break;
              }
            }
          }
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
