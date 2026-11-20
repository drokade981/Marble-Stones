<?php

namespace App\Services\Assistant;

use App\Models\PurchaseOrder;
use App\Models\User;
use App\Services\LandedCostService;
use App\Services\PurchaseOrderService;
use App\Services\StockService;

class ToolManager
{
    public function __construct(
        protected StockService $stockService,
        protected PurchaseOrderService $purchaseOrderService,
        protected LandedCostService $landedCostService
    ) {}

    /**
     * Return JSON Schema definition of all tools for LLM function/tool calling.
     */
    public function getToolDefinitions(): array
    {
        return [
            [
                'name' => 'checkStock',
                'description' => 'Check inventory levels and slabs on hand for a stone or quartz product across warehouses or in a specific city (Houston, Dallas, Chicago).',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'product' => [
                            'type' => 'string',
                            'description' => 'The name, SKU, or material of the stone (e.g. "3cm Calacatta", "Carrara White", "Taj Mahal").',
                        ],
                        'warehouse' => [
                            'type' => 'string',
                            'description' => 'Warehouse city or name (e.g. "Houston", "Dallas", "Chicago"). Omit to check all.',
                        ],
                        'thickness_cm' => [
                            'type' => 'number',
                            'description' => 'Slab thickness in cm (e.g. 2 or 3).',
                        ],
                    ],
                    'required' => ['product'],
                ],
            ],
            [
                'name' => 'searchPurchaseOrders',
                'description' => 'Search or list purchase orders in the ERP. Can filter by supplier name, status (e.g. delayed, confirmed), or delayed flag.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'supplier_name' => [
                            'type' => 'string',
                            'description' => 'Name of the supplier (e.g. "Supplier X", "Supplier Y").',
                        ],
                        'status' => [
                            'type' => 'string',
                            'description' => 'Status of PO (e.g. "delayed", "confirmed", "draft", "received").',
                        ],
                        'delayed_only' => [
                            'type' => 'boolean',
                            'description' => 'Set to true to only return delayed purchase orders.',
                        ],
                        'po_number' => [
                            'type' => 'string',
                            'description' => 'Specific PO number (e.g. "PO-1023").',
                        ],
                    ],
                ],
            ],
            [
                'name' => 'getLandedCost',
                'description' => 'Calculate and retrieve the landed cost per slab (unit cost + share of PO freight) for a given purchase order. STRICT ROLE RESTRICTION: Purchasing team only.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'po_number' => [
                            'type' => 'string',
                            'description' => 'The purchase order identifier (e.g. "PO-1023").',
                        ],
                    ],
                    'required' => ['po_number'],
                ],
            ],
            [
                'name' => 'createDraftPurchaseOrder',
                'description' => 'Prepare a draft purchase order for stone slabs from a supplier. It DOES NOT save directly; it prepares the draft and asks for user confirmation.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'supplier_name' => [
                            'type' => 'string',
                            'description' => 'The supplier name (e.g. "Supplier Y", "Apex Stone Imports").',
                        ],
                        'items' => [
                            'type' => 'array',
                            'description' => 'List of stone items to order.',
                            'items' => [
                                'type' => 'object',
                                'properties' => [
                                    'product' => ['type' => 'string', 'description' => 'Product name or SKU (e.g. "2cm Carrara").'],
                                    'quantity' => ['type' => 'integer', 'description' => 'Number of slabs.'],
                                    'unit_cost' => ['type' => 'number', 'description' => 'Estimated cost per slab.'],
                                ],
                                'required' => ['product', 'quantity'],
                            ],
                        ],
                    ],
                    'required' => ['supplier_name', 'items'],
                ],
            ],
            [
                'name' => 'confirmDraftPurchaseOrder',
                'description' => 'Commit and save a pending draft purchase order to the ERP database after explicit user confirmation (e.g. user replied "confirm").',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'draft_token' => [
                            'type' => 'string',
                            'description' => 'Optional specific draft token to confirm. Defaults to latest user draft.',
                        ],
                    ],
                ],
            ],
        ];
    }

    /**
     * Execute a tool call with strict in-tool role permission enforcement.
     */
    public function execute(string $toolName, array $parameters, User $user, ConversationContext $context): array
    {
        switch ($toolName) {
            case 'checkStock':
                $product = $parameters['product'] ?? $context->getLastProduct();
                $warehouse = $parameters['warehouse'] ?? null;
                $thickness = isset($parameters['thickness_cm']) ? (float) $parameters['thickness_cm'] : $context->getLastThickness();

                $result = $this->stockService->checkStock($product, $warehouse, $thickness);

                // Update context memory
                if (!empty($product)) {
                    $context->setLastProduct($product, $thickness);
                }
                if (!empty($warehouse)) {
                    $context->setLastWarehouse($warehouse);
                }

                return [
                    'tool' => 'checkStock',
                    'allowed' => true,
                    'result' => $result,
                ];

            case 'searchPurchaseOrders':
                $result = $this->purchaseOrderService->search($parameters, $user);

                if (!empty($parameters['po_number'])) {
                    $context->setLastPoNumber($parameters['po_number']);
                }

                return [
                    'tool' => 'searchPurchaseOrders',
                    'allowed' => true,
                    'result' => $result,
                ];

            case 'getLandedCost':
                // Strict Role Check: Page 2 & 4 Requirement
                // A Sales user asking for landed cost gets a polite refusal, not the number!
                if ($user->isSales()) {
                    return [
                        'tool' => 'getLandedCost',
                        'allowed' => false,
                        'polite_refusal' => 'Cost details are only available to the Purchasing team.',
                    ];
                }

                $poNumber = $parameters['po_number'] ?? $context->getLastPoNumber();
                if (empty($poNumber)) {
                    return [
                        'tool' => 'getLandedCost',
                        'allowed' => true,
                        'error' => 'Please provide a valid Purchase Order number (e.g. PO-1023).',
                    ];
                }

                $po = PurchaseOrder::where('po_number', strtoupper(trim($poNumber)))->first();
                if (!$po) {
                    return [
                        'tool' => 'getLandedCost',
                        'allowed' => true,
                        'error' => "Purchase Order '{$poNumber}' was not found in the ERP.",
                    ];
                }

                $context->setLastPoNumber($po->po_number);
                $landedCost = $this->landedCostService->calculateForPurchaseOrder($po);

                return [
                    'tool' => 'getLandedCost',
                    'allowed' => true,
                    'result' => $landedCost,
                ];

            case 'createDraftPurchaseOrder':
                // Strict Role Check: Page 3 & 4 Requirement
                if ($user->isSales()) {
                    return [
                        'tool' => 'createDraftPurchaseOrder',
                        'allowed' => false,
                        'polite_refusal' => 'Creating purchase orders is only permitted for the Purchasing team.',
                    ];
                }

                $supplier = $parameters['supplier_name'] ?? '';
                $items = $parameters['items'] ?? [];

                $draftResult = $this->purchaseOrderService->createDraft($user, $supplier, $items);

                if (($draftResult['status'] ?? '') === 'draft_pending_confirmation') {
                    $context->setPendingDraftToken($draftResult['draft_token']);
                }

                return [
                    'tool' => 'createDraftPurchaseOrder',
                    'allowed' => true,
                    'result' => $draftResult,
                ];

            case 'confirmDraftPurchaseOrder':
                // Strict Role Check
                if ($user->isSales()) {
                    return [
                        'tool' => 'confirmDraftPurchaseOrder',
                        'allowed' => false,
                        'polite_refusal' => 'Confirming purchase orders is only permitted for the Purchasing team.',
                    ];
                }

                $draftToken = $parameters['draft_token'] ?? $context->getPendingDraftToken();
                $confirmResult = $this->purchaseOrderService->confirmDraft($user, $draftToken);

                if (($confirmResult['status'] ?? '') === 'saved') {
                    $context->clearPendingDraft();
                }

                return [
                    'tool' => 'confirmDraftPurchaseOrder',
                    'allowed' => true,
                    'result' => $confirmResult,
                ];

            default:
                return [
                    'tool' => $toolName,
                    'allowed' => false,
                    'error' => "Unknown tool '{$toolName}'.",
                ];
        }
    }
}

