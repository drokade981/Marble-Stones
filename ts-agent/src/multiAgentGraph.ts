import { ChatGoogle } from '@langchain/google';
import { tool } from '@langchain/core/tools';
import { AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { Annotation, END, MemorySaver, messagesStateReducer, START, StateGraph } from '@langchain/langgraph';
import z from 'zod';
import { ErpClient, UserProfile } from './erpClient';

export type AgentRoute = 'inventory_agent' | 'purchasing_agent' | 'general_agent';

export interface SessionContext {
  lastProduct?: string;
  lastWarehouse?: string;
  lastThickness?: number;
  lastPoNumber?: string;
  pendingDraftToken?: string;
}

export interface IntentHelpers {
  extractCity: (message: string) => string | undefined;
  isGreetingOrHelp: (message: string) => boolean;
  isOutOfDomainQuestion: (message: string) => boolean;
  isRelevantToDatabase: (message: string, ctx: SessionContext, hasHistory: boolean) => boolean;
  detectDraftPoIntent: (lower: string) => boolean;
  detectConfirmIntent: (lower: string) => boolean;
  detectPoSearchIntent: (lower: string) => boolean;
  detectStockIntent: (lower: string) => boolean;
  isPromptInjection: (lower: string) => boolean;
}

export const MultiAgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  nextAgent: Annotation<AgentRoute>({
    reducer: (_prev, next) => next,
    default: () => 'general_agent',
  }),
  user: Annotation<UserProfile>({
    reducer: (_prev, next) => next,
  }),
  token: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  conversationId: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  toolsCalled: Annotation<any[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  toolIterations: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  sessionContext: Annotation<SessionContext>({
    reducer: (prev, next) => ({ ...prev, ...next }),
    default: () => ({}),
  }),
  finalReply: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
});

export type MultiAgentStateType = typeof MultiAgentState.State;

export function extractCleanText(content: any): string {
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

function getLatestUserText(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]._getType() === 'human') {
      return extractCleanText(messages[i].content);
    }
  }
  return '';
}

function getRecentConversationSlice(messages: BaseMessage[], limit = 10): BaseMessage[] {
  // Keep only HumanMessage and clean AIMessage (without tool_calls) for cross-agent context,
  // plus any active tool loop messages from the current turn.
  const result: BaseMessage[] = [];
  for (let i = Math.max(0, messages.length - limit); i < messages.length; i++) {
    result.push(messages[i]);
  }
  return result;
}

const MAX_TOOL_ITERATIONS = 5;

export function buildMultiAgentGraph(
  erpClient: ErpClient,
  getLlm: () => ChatGoogle | null,
  checkpointer: MemorySaver,
  helpers: IntentHelpers,
  fallbackFn: (
    message: string,
    user: UserProfile,
    token: string,
    ctx: SessionContext
  ) => Promise<{ reply: string; toolsCalled: any[]; updatedContext: SessionContext }>
) {
  // ── Tool builders scoped per agent & user role ─────────────────────────────

  const makeExecuteSqlTool = (user: UserProfile) =>
    tool(
      async ({ sql }) => sql,
      {
        name: 'execute_sql',
        description:
          'Execute a read-only MySQL SELECT query against the ERP database (Text-to-SQL). ' +
          'Use this to query products, slabs on hand, warehouses by any city name, suppliers, or purchase orders. ' +
          (user.role === 'sales'
            ? 'SALES RESTRICTION: NEVER select freight_cost, unit_cost, bank_details, or rows with status = "draft".'
            : ''),
        schema: z.object({
          sql: z.string().describe('MySQL SELECT statement to execute against the laravel_erp database.'),
        }),
      }
    );

  const makeCheckStockTool = () =>
    tool(
      async (args) => JSON.stringify(args),
      {
        name: 'check_stock',
        description:
          'Check live slab inventory for any stone or quartz product. ' +
          'The warehouse parameter accepts any city name the user mentions — the backend resolves it against the ERP database.',
        schema: z.object({
          product: z.string().optional().describe('Product name, material, or color. Omit to reuse previously mentioned product.'),
          warehouse: z.string().optional().describe('Any city name the user mentioned as a warehouse location.'),
          thickness_cm: z.number().optional().describe('Slab thickness in centimetres (e.g. 2 or 3).'),
        }),
      }
    );

  const makeSearchPurchaseOrdersTool = () =>
    tool(
      async (args) => JSON.stringify(args),
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

  const makeGetLandedCostTool = () =>
    tool(
      async (args) => JSON.stringify(args),
      {
        name: 'get_landed_cost',
        description: 'Calculate landed cost per slab (unit cost + share of freight) for a purchase order. RESTRICTED TO PURCHASING TEAM.',
        schema: z.object({
          po_number: z.string().describe('Purchase order number (e.g. "PO-1023").'),
        }),
      }
    );

  const makeCreateDraftPoTool = () =>
    tool(
      async (args) => JSON.stringify(args),
      {
        name: 'create_draft_purchase_order',
        description: 'Prepare a draft purchase order and present it for confirmation. RESTRICTED TO PURCHASING TEAM.',
        schema: z.object({
          supplier_name: z.string().describe('Supplier name as stated by the user.'),
          items: z.array(
            z.object({
              product: z.string().describe('Product name or description.'),
              quantity: z.number().describe('Number of slabs.'),
              unit_cost: z.number().optional().describe('Unit cost per slab if known.'),
            })
          ).describe('Line items to include in the purchase order.'),
          estimated_freight: z.number().optional().describe('Estimated freight cost if stated.'),
        }),
      }
    );

  const makeConfirmDraftPoTool = () =>
    tool(
      async (args) => JSON.stringify(args),
      {
        name: 'confirm_draft_purchase_order',
        description: 'Confirm and persist a draft purchase order to the ERP database. RESTRICTED TO PURCHASING TEAM.',
        schema: z.object({
          draft_token: z.string().optional().describe('Draft token returned by create_draft_purchase_order.'),
        }),
      }
    );

  // ── Shared tool executor for LangGraph tool nodes ──────────────────────────

  async function executeToolCallsForState(
    state: MultiAgentStateType,
    allowedToolNames: Set<string>
  ): Promise<Partial<MultiAgentStateType>> {
    const lastMsg = state.messages[state.messages.length - 1] as AIMessage;
    const toolCalls = lastMsg?.tool_calls || [];
    const newMessages: ToolMessage[] = [];
    const newToolsCalled: any[] = [];
    const ctx: SessionContext = { ...state.sessionContext };

    for (const tc of toolCalls) {
      const name = tc.name;
      const args: any = tc.args || {};
      let result: any;
      let recordedName = name;
      let recordedInput = args;

      if (!allowedToolNames.has(name)) {
        result = {
          allowed: false,
          polite_refusal: 'This action is restricted for your role.',
        };
      } else {
        switch (name) {
          case 'execute_sql': {
            result = await erpClient.executeSql(state.token, args.sql);
            recordedName = 'execute_sql';
            recordedInput = { sql: args.sql };
            break;
          }
          case 'check_stock': {
            const prod = args.product || ctx.lastProduct || '';
            const thick = args.thickness_cm ?? ctx.lastThickness;
            const wh = args.warehouse || ctx.lastWarehouse;
            result = await erpClient.checkStock(state.token, {
              product: prod,
              warehouse: wh,
              thickness_cm: thick,
            });
            if (prod) ctx.lastProduct = prod;
            if (thick) ctx.lastThickness = thick;
            if (wh) ctx.lastWarehouse = wh;
            recordedName = 'checkStock';
            recordedInput = { product: prod, warehouse: wh, thickness_cm: thick };
            break;
          }
          case 'search_purchase_orders': {
            result = await erpClient.searchPurchaseOrders(state.token, {
              supplier_name: args.supplier_name,
              delayed_only: args.delayed_only,
              po_number: args.po_number,
            });
            if (args.po_number) ctx.lastPoNumber = args.po_number;
            recordedName = 'searchPurchaseOrders';
            break;
          }
          case 'get_landed_cost': {
            if (state.user.role === 'sales') {
              result = {
                allowed: false,
                polite_refusal: 'Cost details are only available to the Purchasing team.',
              };
            } else {
              result = await erpClient.getLandedCost(state.token, args.po_number);
              if (args.po_number) ctx.lastPoNumber = args.po_number;
            }
            recordedName = 'getLandedCost';
            break;
          }
          case 'create_draft_purchase_order': {
            if (state.user.role === 'sales') {
              result = {
                allowed: false,
                polite_refusal: 'Creating draft purchase orders is restricted to the Purchasing team.',
              };
            } else {
              result = await erpClient.createDraftPO(state.token, {
                supplier_name: args.supplier_name,
                items: args.items,
                estimated_freight: args.estimated_freight,
              });
              if (result?.draft_token) {
                ctx.pendingDraftToken = result.draft_token;
              }
            }
            recordedName = 'createDraftPurchaseOrder';
            break;
          }
          case 'confirm_draft_purchase_order': {
            if (state.user.role === 'sales') {
              result = {
                allowed: false,
                polite_refusal: 'Confirming purchase orders is restricted to the Purchasing team.',
              };
            } else {
              const tokenToUse = args.draft_token || ctx.pendingDraftToken;
              result = await erpClient.confirmDraftPO(state.token, tokenToUse);
              ctx.pendingDraftToken = undefined;
            }
            recordedName = 'confirmDraftPurchaseOrder';
            recordedInput = { draft_token: args.draft_token || ctx.pendingDraftToken };
            break;
          }
          default:
            result = { error: `Unknown tool: ${name}` };
        }
      }

      newToolsCalled.push({ tool: recordedName, input: recordedInput, output: result });
      newMessages.push(
        new ToolMessage({
          tool_call_id: tc.id || name,
          name,
          content: typeof result === 'string' ? result : JSON.stringify(result),
        })
      );
    }

    return {
      messages: newMessages,
      toolsCalled: [...state.toolsCalled, ...newToolsCalled],
      toolIterations: state.toolIterations + 1,
      sessionContext: ctx,
    };
  }

  // ── NODE 1: Supervisor / LLM Router Node ───────────────────────────────────

  async function supervisorNode(state: MultiAgentStateType): Promise<Partial<MultiAgentStateType>> {
    const userText = getLatestUserText(state.messages);
    const lower = userText.trim().toLowerCase();

    // Update session context hints from the latest message
    const updatedCtx: SessionContext = { ...state.sessionContext };
    const thickMatch = lower.match(/\b(\d+(?:\.\d+)?)\s*cm\b/i);
    if (thickMatch) updatedCtx.lastThickness = parseFloat(thickMatch[1]);
    const cityDetected = helpers.extractCity(userText);
    if (cityDetected) updatedCtx.lastWarehouse = cityDetected;

    // Fast security / boundary guards before calling LLM router
    if (helpers.isPromptInjection(lower) || helpers.isOutOfDomainQuestion(userText)) {
      return { nextAgent: 'general_agent', sessionContext: updatedCtx };
    }

    const llm = getLlm();
    if (llm) {
      try {
        const recentHistory = state.messages
          .slice(-6, -1)
          .map((m) => `${m._getType() === 'human' ? 'User' : 'Assistant'}: ${extractCleanText(m.content).slice(0, 140)}`)
          .join('\n');

        const routerPrompt = `You are the Supervisor Router in a LangGraph multi-agent ERP system for a US natural stone & quartz slab distributor.
Analyze the user's latest message (and conversation history if it is a short follow-up like "And in Dallas?" or "confirm") and select EXACTLY ONE specialist agent node:

1. inventory_agent — Slab inventory, stock counts, warehouse locations (any city), stone/quartz products, thickness, availability, or follow-up city/thickness queries.
2. purchasing_agent — Purchase orders (POs), delayed/late orders, suppliers, landed costs, unit/freight costs, creating draft POs, or confirming a draft PO.
3. general_agent — Greetings, small talk, capability questions ("what can you do"), or off-topic questions unrelated to stone inventory and purchasing.

${recentHistory ? `Recent conversation:\n${recentHistory}\n` : ''}Latest user message: "${userText}"

Respond with ONLY one exact token: inventory_agent, purchasing_agent, or general_agent.`;

        const routeRes = await llm.invoke([new HumanMessage(routerPrompt)]);
        const routeText = extractCleanText(routeRes.content).toLowerCase();

        if (routeText.includes('purchasing_agent')) {
          return { nextAgent: 'purchasing_agent', sessionContext: updatedCtx };
        }
        if (routeText.includes('inventory_agent')) {
          return { nextAgent: 'inventory_agent', sessionContext: updatedCtx };
        }
        if (routeText.includes('general_agent')) {
          return { nextAgent: 'general_agent', sessionContext: updatedCtx };
        }
      } catch (err: any) {
        console.warn('LangGraph supervisor LLM routing failed, using structural fallback:', err?.message || err);
      }
    }

    // Structural fallback routing when LLM is unavailable or ambiguous
    if (helpers.isGreetingOrHelp(userText)) {
      return { nextAgent: 'general_agent', sessionContext: updatedCtx };
    }
    if (
      helpers.detectConfirmIntent(lower) ||
      helpers.detectDraftPoIntent(lower) ||
      helpers.detectPoSearchIntent(lower) ||
      /\b(?:landed\s+cost|cost\s+per\s+slab|unit\s+cost|freight\s+cost|po[-\s]?\d+)\b/i.test(lower)
    ) {
      return { nextAgent: 'purchasing_agent', sessionContext: updatedCtx };
    }
    if (
      helpers.extractCity(userText) ||
      helpers.detectStockIntent(lower) ||
      (state.messages.length > 1 && lower.split(/\s+/).filter(Boolean).length <= 4)
    ) {
      return { nextAgent: 'inventory_agent', sessionContext: updatedCtx };
    }

    return { nextAgent: 'general_agent', sessionContext: updatedCtx };
  }

  // ── NODE 2: Inventory Specialist Agent ─────────────────────────────────────

  async function inventoryAgentNode(state: MultiAgentStateType): Promise<Partial<MultiAgentStateType>> {
    const userText = getLatestUserText(state.messages);
    const llm = getLlm();

    if (!llm) {
      const fb = await fallbackFn(userText, state.user, state.token, state.sessionContext);
      return {
        messages: [new AIMessage(fb.reply)],
        toolsCalled: [...state.toolsCalled, ...fb.toolsCalled],
        sessionContext: fb.updatedContext,
        finalReply: fb.reply,
      };
    }

    try {
      const tools = [makeCheckStockTool(), makeExecuteSqlTool(state.user)];
      const llmWithTools = llm.bindTools(tools);

      const sysPrompt = `You are the Inventory Specialist Agent in a LangGraph multi-agent ERP system for a US natural stone & quartz slab distributor.
Logged-in staff: ${state.user.name} (Role: ${state.user.role}).
Session context: lastProduct=${state.sessionContext.lastProduct || 'none'}, lastWarehouse=${state.sessionContext.lastWarehouse || 'none'}, lastThickness=${state.sessionContext.lastThickness || 'none'}.

TOOLS & SCHEMA (laravel_erp):
- \`check_stock\`: Check live slab inventory for any product/thickness/warehouse city.
- \`execute_sql\`: Read-only MySQL SELECT against \`products\` (id, sku, name, material, color, thickness_cm, slab_size), \`warehouses\` (id, name, city), \`stock\` (id, product_id, warehouse_id, slabs_on_hand).

RULES:
1. Always query live data using \`check_stock\` or \`execute_sql\` before answering.
2. Users may ask about ANY city. If the city has no warehouse in the ERP, reply:
   "We do not have a warehouse recorded for [City]. Our active locations are Houston, Dallas, and Chicago."
3. NEVER output raw SQL, table names, or column names in your response.
4. Use conversation memory for follow-ups like "And in Dallas?" or "what about 3cm?".
${state.user.role === 'sales' ? '5. SALES ROLE: Never expose unit_cost, freight_cost, landed cost, bank_details, or draft POs.' : ''}`;

      const response = await llmWithTools.invoke([
        new SystemMessage(sysPrompt),
        ...getRecentConversationSlice(state.messages, 10),
      ]);

      return { messages: [response] };
    } catch (err: any) {
      console.warn('Inventory agent LLM error, falling back:', err?.message || err);
      const fb = await fallbackFn(userText, state.user, state.token, state.sessionContext);
      return {
        messages: [new AIMessage(fb.reply)],
        toolsCalled: [...state.toolsCalled, ...fb.toolsCalled],
        sessionContext: fb.updatedContext,
        finalReply: fb.reply,
      };
    }
  }

  async function inventoryToolsNode(state: MultiAgentStateType): Promise<Partial<MultiAgentStateType>> {
    return executeToolCallsForState(state, new Set(['check_stock', 'execute_sql']));
  }

  // ── NODE 3: Purchasing Specialist Agent ────────────────────────────────────

  async function purchasingAgentNode(state: MultiAgentStateType): Promise<Partial<MultiAgentStateType>> {
    const userText = getLatestUserText(state.messages);
    const lower = userText.trim().toLowerCase();

    // Strict RBAC guard for Sales role
    if (state.user.role === 'sales') {
      if (helpers.detectDraftPoIntent(lower) || helpers.detectConfirmIntent(lower)) {
        const refusal =
          'I apologize, but creating and confirming draft purchase orders is restricted to the Purchasing team. As a member of the Sales team, you do not have permission to draft or confirm purchase orders.';
        return { messages: [new AIMessage(refusal)], finalReply: refusal };
      }
      if (/\b(?:landed\s+cost|cost\s+per\s+slab|unit\s+cost|freight\s+cost|bank\s+details?)\b/i.test(lower)) {
        const refusal = 'Cost details are only available to the Purchasing team.';
        return { messages: [new AIMessage(refusal)], finalReply: refusal };
      }
    }

    const llm = getLlm();
    if (!llm) {
      const fb = await fallbackFn(userText, state.user, state.token, state.sessionContext);
      return {
        messages: [new AIMessage(fb.reply)],
        toolsCalled: [...state.toolsCalled, ...fb.toolsCalled],
        sessionContext: fb.updatedContext,
        finalReply: fb.reply,
      };
    }

    try {
      const tools =
        state.user.role === 'sales'
          ? [makeSearchPurchaseOrdersTool(), makeExecuteSqlTool(state.user)]
          : [
              makeSearchPurchaseOrdersTool(),
              makeGetLandedCostTool(),
              makeCreateDraftPoTool(),
              makeConfirmDraftPoTool(),
              makeExecuteSqlTool(state.user),
            ];

      const llmWithTools = llm.bindTools(tools);

      const sysPrompt = `You are the Purchasing Specialist Agent in a LangGraph multi-agent ERP system for a US natural stone & quartz slab distributor.
Logged-in staff: ${state.user.name} (Role: ${state.user.role}).
Session context: lastPoNumber=${state.sessionContext.lastPoNumber || 'none'}, pendingDraftToken=${state.sessionContext.pendingDraftToken ? 'ACTIVE' : 'none'}.

SCHEMA (laravel_erp):
- \`suppliers\` (id, name, contact, payment_terms, bank_details)
- \`purchase_orders\` (id, po_number, supplier_id, status ['confirmed','delayed','received','draft'], order_date, eta, freight_cost, notes)
- \`purchase_order_lines\` (id, purchase_order_id, product_id, quantity, unit_cost)
- \`products\` (id, sku, name, material, color, thickness_cm, slab_size)
- Delayed definition: status = 'delayed' OR (status NOT IN ('received','draft') AND eta < CURDATE())

${
  state.user.role === 'sales'
    ? `SALES ROLE RESTRICTIONS (MANDATORY):
- NEVER select or show: freight_cost, unit_cost, landed cost, bank_details, or rows with status = 'draft'.
- Refuse any request to create, draft, or confirm purchase orders.`
    : `PURCHASING ROLE WORKFLOW:
- Use \`search_purchase_orders\` or \`execute_sql\` for PO status & delayed order inquiries.
- Use \`get_landed_cost\` for landed cost per slab calculations.
- When asked to create a draft PO: call \`create_draft_purchase_order\` (default unit_cost = 150.00 if unspecified, default supplier = 'Supplier Y' if unnamed), present the summary, and end ONLY that draft message with: Reply "confirm" to save it.
- When the user confirms a pending draft: call \`confirm_draft_purchase_order\`.
- NEVER add "Reply confirm to save it" to PO search or landed cost responses.`
}
NEVER output raw SQL, table names, or column names in your response.`;

      const response = await llmWithTools.invoke([
        new SystemMessage(sysPrompt),
        ...getRecentConversationSlice(state.messages, 10),
      ]);

      return { messages: [response] };
    } catch (err: any) {
      console.warn('Purchasing agent LLM error, falling back:', err?.message || err);
      const fb = await fallbackFn(userText, state.user, state.token, state.sessionContext);
      return {
        messages: [new AIMessage(fb.reply)],
        toolsCalled: [...state.toolsCalled, ...fb.toolsCalled],
        sessionContext: fb.updatedContext,
        finalReply: fb.reply,
      };
    }
  }

  async function purchasingToolsNode(state: MultiAgentStateType): Promise<Partial<MultiAgentStateType>> {
    const allowed =
      state.user.role === 'sales'
        ? new Set(['search_purchase_orders', 'execute_sql'])
        : new Set([
            'search_purchase_orders',
            'get_landed_cost',
            'create_draft_purchase_order',
            'confirm_draft_purchase_order',
            'execute_sql',
          ]);
    return executeToolCallsForState(state, allowed);
  }

  // ── NODE 4: General / Boundary Guard Agent ─────────────────────────────────

  async function generalAgentNode(state: MultiAgentStateType): Promise<Partial<MultiAgentStateType>> {
    const userText = getLatestUserText(state.messages);
    const lower = userText.trim().toLowerCase();

    if (helpers.isPromptInjection(lower)) {
      const reply =
        'Adversarial instruction or system override attempt detected. The AI assistant only answers inventory and purchasing questions within verified role bounds.';
      return { messages: [new AIMessage(reply)], finalReply: reply };
    }

    if (helpers.isOutOfDomainQuestion(userText)) {
      const reply = "I don't have proper data about it. I can only answer about inventory and purchasing.";
      return { messages: [new AIMessage(reply)], finalReply: reply };
    }

    if (helpers.isGreetingOrHelp(userText)) {
      const llm = getLlm();
      if (llm) {
        try {
          const res = await llm.invoke([
            new SystemMessage(
              `You are the ERP Assistant for a US natural stone & quartz slab distributor. Greet ${state.user.name} (Role: ${state.user.role}) concisely and mention you can help with warehouse slab inventory, purchase orders${state.user.role === 'purchasing' ? ', landed costs, and draft POs' : ''}.`
            ),
            new HumanMessage(userText),
          ]);
          const reply = extractCleanText(res.content);
          if (reply) {
            return { messages: [new AIMessage(reply)], finalReply: reply };
          }
        } catch {
          // fall through to deterministic greeting
        }
      }
      const reply = `Hello ${state.user.name}! I'm your Stone & Quartz ERP Assistant. I can help you check slab inventory, look up purchase orders, or review landed costs. How can I assist you today?`;
      return { messages: [new AIMessage(reply)], finalReply: reply };
    }

    const reply = "I don't have proper data about it. I can only answer about inventory and purchasing.";
    return { messages: [new AIMessage(reply)], finalReply: reply };
  }

  // ── NODE 5: Finalize / Guardrail Responder Node ────────────────────────────

  function finalizeNode(state: MultiAgentStateType): Partial<MultiAgentStateType> {
    if (state.finalReply) {
      return { finalReply: state.finalReply };
    }

    const lastMsg = state.messages[state.messages.length - 1];
    let reply = lastMsg ? extractCleanText(lastMsg.content) : '';

    if (!reply) {
      const draftTool = state.toolsCalled.find(
        (t) => t.tool === 'createDraftPurchaseOrder' || t.tool === 'create_draft_purchase_order'
      );
      if (draftTool?.output) {
        reply = draftTool.output.prompt || 'Draft purchase order created. Reply "confirm" to save it.';
      } else {
        for (const tc of state.toolsCalled) {
          if (tc.output && tc.output.allowed === false) {
            reply = tc.output.polite_refusal || 'Access to this information is restricted for your role.';
            break;
          }
        }
      }
    }

    const userText = getLatestUserText(state.messages);
    if (
      state.toolsCalled.length === 0 &&
      !helpers.isRelevantToDatabase(userText, state.sessionContext, state.messages.length > 2)
    ) {
      reply = "I don't have proper data about it. I can only answer about inventory and purchasing.";
    }

    return { finalReply: reply || "I'm sorry, I couldn't process that request." };
  }

  // ── Conditional Edge Functions ─────────────────────────────────────────────

  function routeFromSupervisor(state: MultiAgentStateType): AgentRoute {
    return state.nextAgent || 'general_agent';
  }

  function shouldContinueTools(toolsNodeName: 'inventory_tools' | 'purchasing_tools') {
    return (state: MultiAgentStateType): string => {
      const lastMsg = state.messages[state.messages.length - 1] as AIMessage | undefined;
      if (
        lastMsg &&
        Array.isArray(lastMsg.tool_calls) &&
        lastMsg.tool_calls.length > 0 &&
        state.toolIterations < MAX_TOOL_ITERATIONS
      ) {
        return toolsNodeName;
      }
      return 'finalize';
    };
  }

  // ── Assemble & Compile LangGraph StateGraph ────────────────────────────────

  const builder = new StateGraph(MultiAgentState)
    .addNode('supervisor', supervisorNode)
    .addNode('inventory_agent', inventoryAgentNode)
    .addNode('inventory_tools', inventoryToolsNode)
    .addNode('purchasing_agent', purchasingAgentNode)
    .addNode('purchasing_tools', purchasingToolsNode)
    .addNode('general_agent', generalAgentNode)
    .addNode('finalize', finalizeNode)
    .addEdge(START, 'supervisor')
    .addConditionalEdges('supervisor', routeFromSupervisor, {
      inventory_agent: 'inventory_agent',
      purchasing_agent: 'purchasing_agent',
      general_agent: 'general_agent',
    })
    .addConditionalEdges('inventory_agent', shouldContinueTools('inventory_tools'), {
      inventory_tools: 'inventory_tools',
      finalize: 'finalize',
    })
    .addEdge('inventory_tools', 'inventory_agent')
    .addConditionalEdges('purchasing_agent', shouldContinueTools('purchasing_tools'), {
      purchasing_tools: 'purchasing_tools',
      finalize: 'finalize',
    })
    .addEdge('purchasing_tools', 'purchasing_agent')
    .addEdge('general_agent', 'finalize')
    .addEdge('finalize', END);

  return builder.compile({ checkpointer });
}

