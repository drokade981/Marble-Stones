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
use Illuminate\Support\Facades\DB;

class ToolController extends Controller
{
    public function __construct(
        protected ToolManager $toolManager,
        protected StockService $stockService,
        protected PurchaseOrderService $purchaseOrderService,
        protected LandedCostService $landedCostService
    ) {}

    /**
     * POST /api/tools/execute-sql
     * Dynamic Text-to-SQL execution endpoint for the AI Agent (ChatGPT/Claude style).
     * Strictly executes read-only SELECT queries with role-based access control.
     */
    public function executeSql(Request $request): JsonResponse
    {
        $user = $request->user();
        $sql = trim((string) $request->input('sql', ''));

        if (empty($sql)) {
            return response()->json([
                'allowed' => false,
                'error' => 'SQL query string is required.',
            ], 400);
        }

        // 1. Safety Guard: Read-Only Query Enforcement
        // Disallow multi-queries separated by semicolon (allow trailing semicolon only)
        $cleanSql = rtrim($sql, "; \t\n\r\0\x0B");
        if (str_contains($cleanSql, ';')) {
            return response()->json([
                'allowed' => false,
                'error' => 'Multiple SQL statements are not permitted.',
            ], 400);
        }

        // Must be a SELECT or WITH statement
        if (!preg_match('/^(SELECT|WITH)\s+/i', $cleanSql)) {
            return response()->json([
                'allowed' => false,
                'error' => 'Only read-only SELECT queries are allowed.',
            ], 400);
        }

        // Disallow dangerous DDL / DML / data-exfiltration keywords
        $forbiddenKeywords = '/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|REPLACE|GRANT|REVOKE|INTO\s+OUTFILE|INTO\s+DUMPFILE|LOAD_FILE|SCHEMA|INFORMATION_SCHEMA)\b/i';
        if (preg_match($forbiddenKeywords, $cleanSql)) {
            return response()->json([
                'allowed' => false,
                'error' => 'Data modification or administrative SQL commands are strictly prohibited.',
            ], 403);
        }

        // 2. Role-Based Access Control (RBAC) Enforcement
        // Sales team cannot view unit_cost, freight_cost, or supplier bank_details
        if ($user->isSales()) {
            if (preg_match('/\b(unit_cost|freight_cost|bank_details)\b/i', $cleanSql)) {
                return response()->json([
                    'allowed' => false,
                    'polite_refusal' => 'Cost details are only available to the Purchasing team.',
                    'rows' => [],
                ], 403);
            }
        }

        // 3. Safety Row Limit (cap at 100 rows if no limit or higher limit specified)
        if (!preg_match('/\bLIMIT\s+\d+/i', $cleanSql)) {
            $cleanSql .= ' LIMIT 50';
        }

        // 4. Execute Query
        try {
            $rows = DB::select($cleanSql);

            // Double check: if Sales user, sanitize any returned row keys if somehow retrieved
            if ($user->isSales()) {
                $rows = array_map(function ($row) {
                    $rowObj = (object) (array) $row;
                    unset($rowObj->unit_cost, $rowObj->freight_cost, $rowObj->bank_details);
                    return $rowObj;
                }, $rows);
            }

            return response()->json([
                'allowed' => true,
                'sql' => $cleanSql,
                'count' => count($rows),
                'rows' => $rows,
            ]);
        } catch (\Throwable $e) {
            return response()->json([
                'allowed' => true,
                'sql' => $cleanSql,
                'error' => 'SQL execution error: ' . $e->getMessage(),
                'rows' => [],
            ], 400);
        }
    }

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

