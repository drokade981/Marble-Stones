<?php

namespace App\Services;

use App\Models\DraftPurchaseOrder;
use App\Models\Product;
use App\Models\PurchaseOrder;
use App\Models\PurchaseOrderLine;
use App\Models\Supplier;
use App\Models\User;
use Carbon\Carbon;
use Illuminate\Support\Str;

class PurchaseOrderService
{
    public function __construct(
        protected LandedCostService $landedCostService,
        protected ProductService $productService
    ) {}

    /**
     * Search purchase orders with strict role-based permission masking.
     *
     * Sales: Can see PO numbers, supplier names, status, ETA, delayed flags, products & quantities.
     *        CANNOT see costs, freight, total amounts, or supplier bank details.
     * Purchasing: Can see all data including financial figures and landed costs.
     */
    public function search(array $filters, User $user): array
    {
        $query = PurchaseOrder::query()->with(['supplier', 'lines.product']);

        if (!empty($filters['po_number'])) {
            $query->where('po_number', 'like', '%' . trim($filters['po_number']) . '%');
        }

        if (!empty($filters['supplier_name'])) {
            $suppName = trim($filters['supplier_name']);
            $query->whereHas('supplier', function ($q) use ($suppName) {
                $q->where('name', 'like', "%{$suppName}%");
            });
        }

        if (!empty($filters['status'])) {
            $status = strtolower(trim($filters['status']));
            $query->where('status', $status);
        }

        // Strict Role Check: Draft purchase orders are never shown to the Sales role
        if ($user->isSales()) {
            $query->where('status', '!=', 'draft');
        }

        $isPurchasing = $user->isPurchasing();
        $today = Carbon::today();

        $orders = $query->orderBy('order_date', 'desc')->get();

        if (!empty($filters['delayed_only'])) {
            $orders = $orders->filter(function ($po) use ($today) {
                return $po->isDelayed();
            })->values();
        }

        $results = [];
        foreach ($orders as $po) {
            $isDelayed = $po->isDelayed();

            $lines = [];
            foreach ($po->lines as $line) {
                $lineData = [
                    'line_id' => $line->id,
                    'sku' => $line->product->sku ?? 'N/A',
                    'product_name' => $line->product->name ?? 'Unknown',
                    'thickness_cm' => $line->product->thickness_cm ?? null,
                    'quantity' => (int) $line->quantity,
                ];

                // Role check: Only Purchasing sees unit costs
                if ($isPurchasing) {
                    $lineData['unit_cost'] = (float) $line->unit_cost;
                    $lineData['line_total'] = round($line->quantity * $line->unit_cost, 2);
                }

                $lines[] = $lineData;
            }

            $orderData = [
                'po_number' => $po->po_number,
                'supplier_name' => $po->supplier->name ?? 'Unknown',
                'status' => $po->status,
                'is_delayed' => $isDelayed,
                'order_date' => $po->order_date?->toDateString(),
                'eta' => $po->eta?->toDateString(),
                'total_slabs' => (int) $po->lines->sum('quantity'),
                'lines' => $lines,
            ];

            // Role check: Costs, freight & bank details restricted to Purchasing
            if ($isPurchasing) {
                $orderData['freight_cost'] = (float) $po->freight_cost;
                $orderData['total_amount'] = (float) $po->total_product_cost;
                $orderData['total_landed_cost'] = (float) $po->total_landed_cost;
                $orderData['supplier_bank_details'] = $po->supplier->bank_details ?? null;
            } else {
                $orderData['financial_note'] = 'Financial details (costs & freight) are hidden for the Sales role.';
            }

            $results[] = $orderData;
        }

        return [
            'count' => count($results),
            'role' => $user->role,
            'delayed_filter_applied' => !empty($filters['delayed_only']),
            'purchase_orders' => $results,
        ];
    }

    /**
     * Create a pending draft PO without committing it to the database yet.
     * Enforces confirm-before-save pattern.
     */
    public function createDraft(User $user, string $supplierName, array $items, float $estimatedFreight = 0.0): array
    {
        if (!$user->isPurchasing()) {
            return [
                'status' => 'forbidden',
                'error' => 'Draft purchase order creation is restricted to the Purchasing team.',
            ];
        }

        // Find supplier (or fallback to default system supplier if unspecified)
        $supplier = null;
        if (!empty($supplierName)) {
            $supplier = Supplier::where('name', 'like', "%{$supplierName}%")->first();
        }
        if (!$supplier) {
            $supplier = Supplier::first();
        }

        if (!$supplier) {
            return [
                'status' => 'error',
                'message' => "No supplier found in the system.",
            ];
        }

        // Process items
        $resolvedItems = [];
        $itemDescriptions = [];

        foreach ($items as $item) {
            $productIdentifier = $item['product_name_or_sku'] ?? $item['product'] ?? '';
            $thickness = isset($item['thickness_cm']) ? (float) $item['thickness_cm'] : null;
            if (!$thickness && preg_match('/(\d+(\.\d+)?)\s*cm/i', $productIdentifier, $m)) {
                $thickness = (float) $m[1];
            }

            $product = $this->productService->findBySkuOrName($productIdentifier, $thickness);

            if (!$product) {
                // Try broader search
                $found = $this->productService->search($productIdentifier, $thickness);
                $product = $found->first();
            }

            if (!$product) {
                // Try searching without thickness constraint or cleaning thickness string
                $cleanedName = trim(preg_replace('/(\d+(\.\d+)?)\s*cm/i', '', $productIdentifier));
                $product = $this->productService->findBySkuOrName($cleanedName ?: $productIdentifier, null);
                if (!$product) {
                    $found = $this->productService->search($cleanedName ?: $productIdentifier, null);
                    $product = $found->first();
                }
            }

            if (!$product) {
                // Auto-create or resolve custom product entry so drafting custom orders succeeds
                $cleanSku = 'CUST-' . strtoupper(substr(preg_replace('/[^a-zA-Z0-9]/', '', $productIdentifier), 0, 8)) . '-' . (int) ($thickness ?? 2) . 'CM';
                $product = Product::firstOrCreate(
                    ['sku' => $cleanSku],
                    [
                        'name' => trim(preg_replace('/(\d+(\.\d+)?)\s*cm/i', '', $productIdentifier)),
                        'material' => 'Natural Stone',
                        'color' => 'Custom',
                        'thickness_cm' => $thickness ?? 2.0,
                        'slab_size' => '126x63 in',
                    ]
                );
            }

            $qty = (int) ($item['quantity'] ?? 1);
            $unitCost = (float) ($item['unit_cost'] ?? 100.00); // Standard default or provided

            $resolvedItems[] = [
                'product_id' => $product->id,
                'sku' => $product->sku,
                'name' => $product->name,
                'thickness_cm' => $product->thickness_cm,
                'quantity' => $qty,
                'unit_cost' => $unitCost,
            ];

            $itemDescriptions[] = "{$qty} slabs of {$product->thickness_cm}cm {$product->name}";
        }

        $itemsSummary = implode(', ', $itemDescriptions);
        $summary = "{$itemsSummary} from {$supplier->name}";

        $draftToken = 'draft_' . Str::random(12);

        // Cancel any existing pending drafts for this user to avoid stale confirmations
        DraftPurchaseOrder::where('user_id', $user->id)
            ->where('status', 'pending_confirmation')
            ->update(['status' => 'discarded']);

        $draft = DraftPurchaseOrder::create([
            'draft_token' => $draftToken,
            'user_id' => $user->id,
            'supplier_id' => $supplier->id,
            'items' => $resolvedItems,
            'estimated_freight' => $estimatedFreight,
            'status' => 'pending_confirmation',
            'summary_text' => $summary,
        ]);

        return [
            'status' => 'draft_pending_confirmation',
            'draft_token' => $draftToken,
            'supplier' => $supplier->name,
            'summary' => $summary,
            'items' => $resolvedItems,
            'estimated_freight' => $estimatedFreight,
            'prompt' => "Here's the draft: {$summary}. Reply \"confirm\" to save it.",
        ];
    }

    /**
     * Confirm and persist a pending draft purchase order.
     */
    public function confirmDraft(User $user, ?string $draftToken = null): array
    {
        if (!$user->isPurchasing()) {
            return [
                'status' => 'forbidden',
                'error' => 'Purchase order confirmation is restricted to the Purchasing team.',
            ];
        }

        $query = DraftPurchaseOrder::where('user_id', $user->id)
            ->where('status', 'pending_confirmation');

        if ($draftToken) {
            $query->where('draft_token', $draftToken);
        }

        $draft = $query->latest()->first();

        if (!$draft) {
            return [
                'status' => 'error',
                'message' => 'No pending draft purchase order was found to confirm.',
            ];
        }

        // Generate next unique PO Number by inspecting maximum existing number
        $maxNum = PurchaseOrder::all()->map(function ($order) {
            preg_match('/PO-(\d+)/i', $order->po_number, $matches);
            return isset($matches[1]) ? (int) $matches[1] : 0;
        })->max() ?: 1000;

        $poNumber = 'PO-' . ($maxNum + 1);

        $today = Carbon::today();
        $po = PurchaseOrder::create([
            'po_number' => $poNumber,
            'supplier_id' => $draft->supplier_id,
            'status' => 'confirmed',
            'order_date' => $today,
            'eta' => $today->copy()->addDays(30),
            'freight_cost' => $draft->estimated_freight ?: 1000.00,
            'notes' => "Created via AI Assistant for draft: {$draft->summary_text}",
        ]);

        foreach ($draft->items as $item) {
            PurchaseOrderLine::create([
                'purchase_order_id' => $po->id,
                'product_id' => $item['product_id'],
                'quantity' => $item['quantity'],
                'unit_cost' => $item['unit_cost'],
            ]);
        }

        $draft->update(['status' => 'confirmed']);

        return [
            'status' => 'saved',
            'po_number' => $poNumber,
            'supplier' => $po->supplier->name ?? 'Unknown',
            'total_slabs' => $po->total_slabs,
            'eta' => $po->eta->toDateString(),
            'message' => "Purchase Order {$poNumber} has been successfully created and saved for {$draft->summary_text}.",
        ];
    }
}
