<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\CheckStockRequest;
use App\Http\Requests\CreateDraftPORequest;
use App\Http\Requests\LandedCostRequest;
use App\Http\Requests\SearchPoRequest;
use App\Models\PurchaseOrder;
use App\Services\Assistant\ConversationContext;
use App\Services\Assistant\ToolManager;
use App\Services\LandedCostService;
use App\Services\PurchaseOrderService;
use App\Services\StockService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class ToolController extends Controller
{
    public function __construct(
        protected ToolManager $toolManager,
        protected StockService $stockService,
        protected PurchaseOrderService $purchaseOrderService,
        protected LandedCostService $landedCostService
    ) {}

    /**
     * GET /api/tools/definitions
     * Return schema descriptions for all ERP tools.
     */
    public function definitions(): JsonResponse
    {
        return response()->json([
            'tools' => $this->toolManager->getToolDefinitions(),
        ]);
    }

    /**
     * POST /api/tools/check-stock
     */
    public function checkStock(CheckStockRequest $request): JsonResponse
    {
        $result = $this->stockService->checkStock(
            $request->validated('product'),
            $request->validated('warehouse'),
            $request->validated('thickness_cm')
        );

        return response()->json($result);
    }

    /**
     * POST /api/tools/search-purchase-orders
     */
    public function searchPurchaseOrders(SearchPoRequest $request): JsonResponse
    {
        $result = $this->purchaseOrderService->search($request->validated(), $request->user());

        return response()->json($result);
    }

    /**
     * POST /api/tools/get-landed-cost
     * Role check: Sales users get polite refusal.
     */
    public function getLandedCost(LandedCostRequest $request): JsonResponse
    {
        $user = $request->user();

        // Strict role check: Sales blocked
        if ($user->isSales()) {
            return response()->json([
                'allowed' => false,
                'polite_refusal' => 'Cost details are only available to the Purchasing team.',
            ], 403);
        }

        $poNumber = strtoupper(trim($request->validated('po_number')));
        $po = PurchaseOrder::where('po_number', $poNumber)->first();

        if (!$po) {
            return response()->json([
                'error' => "Purchase Order '{$poNumber}' was not found.",
            ], 404);
        }

        $landedCost = $this->landedCostService->calculateForPurchaseOrder($po);

        return response()->json([
            'allowed' => true,
            'data' => $landedCost,
        ]);
    }

    /**
     * POST /api/tools/create-draft-po
     * Role check: Purchasing only. Prepares unconfirmed draft.
     */
    public function createDraftPO(CreateDraftPORequest $request): JsonResponse
    {
        $user = $request->user();

        if ($user->isSales()) {
            return response()->json([
                'allowed' => false,
                'polite_refusal' => 'Draft purchase order creation is restricted to the Purchasing team.',
            ], 403);
        }

        $result = $this->purchaseOrderService->createDraft(
            $user,
            $request->validated('supplier_name'),
            $request->validated('items'),
            (float) ($request->validated('estimated_freight') ?? 0.0)
        );

        return response()->json($result);
    }

    /**
     * POST /api/tools/confirm-draft-po
     * Role check: Purchasing only. Saves draft into persistent PO.
     */
    public function confirmDraftPO(Request $request): JsonResponse
    {
        $user = $request->user();

        if ($user->isSales()) {
            return response()->json([
                'allowed' => false,
                'polite_refusal' => 'Confirming purchase orders is restricted to the Purchasing team.',
            ], 403);
        }

        $draftToken = $request->input('draft_token');
        $result = $this->purchaseOrderService->confirmDraft($user, $draftToken);

        $status = ($result['status'] ?? '') === 'saved' ? 200 : 400;

        return response()->json($result, $status);
    }
}

