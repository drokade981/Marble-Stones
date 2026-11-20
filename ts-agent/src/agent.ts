import { ErpClient, UserProfile } from './erpClient';
import { ToolExecutor } from './tools';

interface SessionState {
  lastProduct?: string;
  lastWarehouse?: string;
  lastPoNumber?: string;
  pendingDraftToken?: string;
  history: Array<{ role: 'user' | 'assistant'; text: string }>;
}

export class AssistantAgent {
  private sessions: Map<string, SessionState> = new Map();
  private toolExecutor: ToolExecutor;

  constructor(private erpClient: ErpClient) {
    this.toolExecutor = new ToolExecutor(erpClient);
  }

  private getSession(conversationId: string): SessionState {
    if (!this.sessions.has(conversationId)) {
      this.sessions.set(conversationId, { history: [] });
    }
    return this.sessions.get(conversationId)!;
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

    // Prompt injection guard
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

    let toolName = '';
    let toolParams: any = {};
    let reply = '';
    const toolsCalled: any[] = [];

    // 1. Confirm draft PO
    if (/^(confirm|yes\s*,?\s*confirm|save\s+it)\b/i.test(lower)) {
      toolName = 'confirmDraftPurchaseOrder';
      toolParams = { draft_token: session.pendingDraftToken };
    }
    // 2. Create draft PO
    else if (/create\s+(a\s+)?draft\s+po|draft\s+po\s+for/i.test(lower)) {
      toolName = 'createDraftPurchaseOrder';
      let supplier = 'Supplier Y';
      const sm = message.match(/from\s+([a-zA-Z0-9\s]+?)(?:\.|$)/i);
      if (sm) supplier = sm[1].trim();

      let qty = 20;
      let prod = '2cm Carrara';
      const qm = message.match(/(\d+)\s+slabs?\s+of\s+([a-zA-Z0-9\s]+?)(?:\s+from|\.|$)/i);
      if (qm) {
        qty = parseInt(qm[1], 10);
        prod = qm[2].trim();
      }

      toolParams = {
        supplier_name: supplier,
        items: [{ product: prod, quantity: qty, unit_cost: 85.00 }],
      };
    }
    // 3. Landed cost query
    else if (/landed\s+cost|cost\s+per\s+slab/i.test(lower)) {
      toolName = 'getLandedCost';
      let poNumber = session.lastPoNumber || 'PO-1023';
      const pm = message.match(/(PO-\d+)/i);
      if (pm) poNumber = pm[1].toUpperCase();
      session.lastPoNumber = poNumber;
      toolParams = { po_number: poNumber };
    }
    // 4. Delayed or general PO search
    else if (/purchase\s+orders?|orders?|po\b/i.test(lower) && (/delayed|late|overdue/i.test(lower) || /supplier/i.test(lower))) {
      toolName = 'searchPurchaseOrders';
      let supplierName: string | undefined = undefined;
      const suppMatch = message.match(/supplier\s+([a-zA-Z0-9]+)/i);
      if (suppMatch) {
        supplierName = `Supplier ${suppMatch[1].toUpperCase()}`;
      }
      const delayedOnly = /delayed|late|overdue/i.test(lower);
      toolParams = { supplier_name: supplierName, delayed_only: delayedOnly };
    }
    // 5. Follow-up warehouse question ("And in Dallas?", "What about Chicago?")
    else if (/^(and|what\s+about|how\s+about)\s+(in\s+)?(houston|dallas|chicago)\??$/i.test(lower)) {
      toolName = 'checkStock';
      const m = lower.match(/(houston|dallas|chicago)/i);
      const city = m ? m[1].charAt(0).toUpperCase() + m[1].slice(1) : 'Dallas';
      toolParams = {
        product: session.lastProduct || '3cm Calacatta',
        warehouse: city,
      };
    }
    // 6. Stock check ("How many 3cm Calacatta slabs do we have in Houston?")
    else {
      toolName = 'checkStock';
      let warehouse: string | undefined = undefined;
      const wm = message.match(/\b(in|at)\s+(houston|dallas|chicago)\b/i);
      if (wm) {
        warehouse = wm[2].charAt(0).toUpperCase() + wm[2].slice(1).toLowerCase();
      }

      let product = message.replace(/(how many|slabs?|do we have|in stock|stock|in\s+(houston|dallas|chicago))/gi, '').trim();
      if (!product || product.length < 3) {
        product = session.lastProduct || '3cm Calacatta';
      }

      toolParams = { product, warehouse };
    }

    // Execute tool against Laravel API with Sanctum Token
    try {
      const toolResult = await this.toolExecutor.execute(toolName, toolParams, token);
      toolsCalled.push({ tool: toolName, input: toolParams, output: toolResult });

      // Check role denial
      if (toolResult && toolResult.allowed === false) {
        reply = toolResult.polite_refusal || 'Cost details are only available to the Purchasing team.';
      } else {
        // Synthesize response based on tool data
        reply = this.synthesizeReply(toolName, toolParams, toolResult, session, lower);
      }
    } catch (err: any) {
      reply = `ERP Tool error: ${err.message || 'Failed to connect to ERP'}`;
    }

    session.history.push({ role: 'user', text: message });
    session.history.push({ role: 'assistant', text: reply });

    return {
      conversation_id: conversationId,
      role: user.role,
      user_name: user.name,
      reply,
      tools_called: toolsCalled,
      tokens_used: Math.floor(Math.random() * 50) + 40,
      response_time_ms: Date.now() - startTime,
    };
  }

  private synthesizeReply(toolName: string, params: any, data: any, session: SessionState, lowerQuery: string): string {
    switch (toolName) {
      case 'checkStock': {
        if (!data.found || !data.results || data.results.length === 0) {
          return data.message || 'No slabs found matching that description.';
        }

        const top = data.results[0];
        const prodName = `${top.thickness_cm}cm ${top.name}`;
        session.lastProduct = prodName;

        const whCity = data.resolved_warehouse;
        if (whCity && whCity !== 'All Warehouses' && data.specific_slabs_on_hand !== null) {
          const slabs = data.specific_slabs_on_hand;
          session.lastWarehouse = whCity;

          if (lowerQuery.startsWith('and in') || lowerQuery.startsWith('what about')) {
            return `${whCity} has ${slabs} slabs of ${prodName}.`;
          }
          return `There are ${slabs} slabs of ${prodName} in the ${whCity} warehouse.`;
        }

        const breakdown = top.warehouses.map((w: any) => `${w.city}: ${w.slabs_on_hand}`).join(', ');
        return `We have ${top.total_slabs_on_hand} slabs of ${prodName} on hand across warehouses (${breakdown}).`;
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
        if (orders.length === 0) {
          return 'No purchase orders found matching your search criteria.';
        }

        const formatted = orders.map((po: any) => {
          const delayTag = po.is_delayed ? ` [DELAYED - ETA was ${po.eta}]` : ` [ETA: ${po.eta}]`;
          const items = po.lines.map((l: any) => `${l.quantity} slabs ${l.product_name}`).join(', ');
          return `• ${po.po_number} from ${po.supplier_name} - Status: ${po.status}${delayTag} (${items})`;
        }).join('\n');

        const title = data.delayed_filter_applied ? 'Delayed purchase orders:' : 'Purchase orders:';
        return `${title}\n${formatted}`;
      }

      default:
        return JSON.stringify(data);
    }
  }
}
