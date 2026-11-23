import { ErpClient } from './erpClient';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

export class ToolExecutor {
  constructor(private erpClient: ErpClient) {}

  getDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'execute_sql',
        description: 'Execute a read-only MySQL SELECT query against the ERP database to fetch live data (ChatGPT/Claude style text-to-SQL).',
        parameters: {
          type: 'object',
          properties: {
            sql: { type: 'string', description: 'Valid MySQL SELECT query string to execute against laravel_erp.' },
          },
          required: ['sql'],
        },
      },
      {
        name: 'checkStock',
        description: 'Check slabs on hand for a stone/quartz product in a warehouse across any city or location (e.g. Houston, Dallas, Chicago, or any queried city).',
        parameters: {
          type: 'object',
          properties: {
            product: { type: 'string', description: 'Product name or thickness (e.g. "3cm Calacatta", "Carrara"). Optional.' },
            warehouse: { type: 'string', description: 'City name of the warehouse (e.g. "Houston", "Dallas", "Chicago", or any queried location).' },
            thickness_cm: { type: 'number', description: 'Slab thickness in cm (e.g. 2 or 3).' },
          },
        },
      },
      {
        name: 'searchPurchaseOrders',
        description: 'Search purchase orders with filters for supplier name, status, or delayed orders.',
        parameters: {
          type: 'object',
          properties: {
            supplier_name: { type: 'string', description: 'Supplier name (e.g. "Supplier X").' },
            delayed_only: { type: 'boolean', description: 'Only return delayed purchase orders.' },
            po_number: { type: 'string', description: 'Specific PO number (e.g. "PO-1023").' },
          },
        },
      },
      {
        name: 'getLandedCost',
        description: 'Get landed cost per slab (unit cost + share of PO freight). RESTRICTED TO PURCHASING TEAM.',
        parameters: {
          type: 'object',
          properties: {
            po_number: { type: 'string', description: 'Purchase order number (e.g. "PO-1023").' },
          },
          required: ['po_number'],
        },
      },
      {
        name: 'createDraftPurchaseOrder',
        description: 'Prepare a draft PO from a supplier. Asks for confirmation before persisting. RESTRICTED TO PURCHASING TEAM.',
        parameters: {
          type: 'object',
          properties: {
            supplier_name: { type: 'string', description: 'Supplier name (e.g. "Supplier Y").' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  product: { type: 'string' },
                  quantity: { type: 'integer' },
                  unit_cost: { type: 'number' },
                },
              },
            },
          },
          required: ['supplier_name', 'items'],
        },
      },
      {
        name: 'confirmDraftPurchaseOrder',
        description: 'Save and confirm a draft PO to the ERP database after user confirms. RESTRICTED TO PURCHASING TEAM.',
        parameters: {
          type: 'object',
          properties: {
            draft_token: { type: 'string', description: 'Draft token if known.' },
          },
        },
      },
    ];
  }

  async execute(toolName: string, args: any, token: string) {
    switch (toolName) {
      case 'executeSql':
      case 'execute_sql':
        return await this.erpClient.executeSql(token, args.sql);
      case 'checkStock':
        return await this.erpClient.checkStock(token, args);
      case 'searchPurchaseOrders':
        return await this.erpClient.searchPurchaseOrders(token, args);
      case 'getLandedCost':
        return await this.erpClient.getLandedCost(token, args.po_number);
      case 'createDraftPurchaseOrder':
        return await this.erpClient.createDraftPO(token, args);
      case 'confirmDraftPurchaseOrder':
        return await this.erpClient.confirmDraftPO(token, args.draft_token);
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }
}

