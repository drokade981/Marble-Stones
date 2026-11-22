<?php

use App\Http\Controllers\Api\AssistantController;
use App\Http\Controllers\Api\AuthController;
use App\Http\Controllers\Api\ToolController;
use App\Models\Product;
use App\Models\PurchaseOrder;
use App\Models\Supplier;
use App\Models\Warehouse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;

// Public Authentication
Route::post('/login', [AuthController::class, 'login']);

// Authenticated Routes via Laravel Sanctum
Route::middleware('auth:sanctum')->group(function () {
    // Current user profile & permissions
    Route::get('/user', [AuthController::class, 'user']);
    Route::post('/logout', [AuthController::class, 'logout']);

    // Primary AI Assistant API Endpoint
    Route::post('/assistant', [AssistantController::class, 'chat']);
    Route::post('/ts-agent/chat', [AssistantController::class, 'tsAgentChat']);
    Route::get('/assistant/logs', [AssistantController::class, 'logs']);

    // Direct Tool Endpoints for External Agents (e.g. TypeScript Node Agent)
    Route::prefix('tools')->group(function () {
        Route::get('/definitions', [ToolController::class, 'definitions']);
        Route::post('/execute-sql', [ToolController::class, 'executeSql']);
        Route::post('/check-stock', [ToolController::class, 'checkStock']);
        Route::post('/search-purchase-orders', [ToolController::class, 'searchPurchaseOrders']);
        Route::post('/get-landed-cost', [ToolController::class, 'getLandedCost']);
        Route::post('/create-draft-po', [ToolController::class, 'createDraftPO']);
        Route::post('/confirm-draft-po', [ToolController::class, 'confirmDraftPO']);
    });

    // ERP Read Endpoints for UI / Dashboard
    Route::get('/products', function () {
        return response()->json(Product::with('stocks.warehouse')->get());
    });

    Route::get('/warehouses', function () {
        return response()->json(Warehouse::with('stocks.product')->get());
    });

    Route::get('/suppliers', function (Request $request) {
        $user = $request->user();
        $query = Supplier::query();
        if ($user->isSales()) {
            // Exclude encrypted bank details for sales
            $query->select(['id', 'name', 'contact', 'payment_terms', 'created_at']);
        }
        return response()->json($query->get());
    });

    Route::get('/purchase-orders', function (Request $request) {
        $user = $request->user();
        $query = PurchaseOrder::with(['supplier', 'lines.product'])->latest('order_date');
        $orders = $query->get()->map(function ($po) use ($user) {
            $isPurchasing = $user->isPurchasing();
            return [
                'id' => $po->id,
                'po_number' => $po->po_number,
                'supplier' => $po->supplier->name ?? 'Unknown',
                'status' => $po->status,
                'is_delayed' => $po->isDelayed(),
                'order_date' => $po->order_date?->toDateString(),
                'eta' => $po->eta?->toDateString(),
                'total_slabs' => $po->total_slabs,
                'freight_cost' => $isPurchasing ? (float) $po->freight_cost : null,
                'total_cost' => $isPurchasing ? (float) $po->total_landed_cost : null,
                'lines' => $po->lines->map(fn ($l) => [
                    'product' => $l->product->name ?? 'Unknown',
                    'sku' => $l->product->sku ?? '',
                    'quantity' => $l->quantity,
                    'unit_cost' => $isPurchasing ? (float) $l->unit_cost : null,
                ]),
            ];
        });
        return response()->json($orders);
    });
});
