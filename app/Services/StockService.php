<?php

namespace App\Services;

use App\Models\Product;
use App\Models\Stock;
use App\Models\Warehouse;

class StockService
{
    public function __construct(
        protected ProductService $productService
    ) {}

    /**
     * Check stock for a given product query and warehouse.
     */
    public function checkStock(?string $productQuery, ?string $warehouseQuery = null, ?float $thickness = null): array
    {
        $thickness = $thickness ?? $this->extractThickness($productQuery);
        $cleanProductName = $this->cleanProductQuery($productQuery);

        // Find products
        $products = $this->productService->search($cleanProductName, $thickness);

        if ($products->isEmpty() && !empty($cleanProductName)) {
            // Fallback: match without thickness
            $products = $this->productService->search($cleanProductName);
        }

        if ($products->isEmpty()) {
            return [
                'found' => false,
                'message' => "No products found matching '{$productQuery}'.",
                'results' => [],
            ];
        }

        // Find warehouse if specified
        $warehouse = null;
        if (!empty($warehouseQuery)) {
            $warehouse = Warehouse::where('city', 'like', "%{$warehouseQuery}%")
                ->orWhere('name', 'like', "%{$warehouseQuery}%")
                ->first();
        }

        $results = [];
        foreach ($products as $prod) {
            $stockQuery = Stock::query()->where('product_id', $prod->id)->with('warehouse');
            if ($warehouse) {
                $stockQuery->where('warehouse_id', $warehouse->id);
            }

            $stocks = $stockQuery->get();

            $warehouseBreakdown = [];
            $totalOnHand = 0;

            foreach ($stocks as $s) {
                $warehouseBreakdown[] = [
                    'warehouse_id' => $s->warehouse_id,
                    'warehouse_name' => $s->warehouse->name,
                    'city' => $s->warehouse->city,
                    'slabs_on_hand' => (int) $s->slabs_on_hand,
                ];
                $totalOnHand += (int) $s->slabs_on_hand;
            }

            $results[] = [
                'product_id' => $prod->id,
                'sku' => $prod->sku,
                'name' => $prod->name,
                'material' => $prod->material,
                'color' => $prod->color,
                'thickness_cm' => (float) $prod->thickness_cm,
                'slab_size' => $prod->slab_size,
                'total_slabs_on_hand' => $totalOnHand,
                'warehouses' => $warehouseBreakdown,
            ];
        }

        $specificSlabs = null;
        if ($warehouse && count($results) > 0 && count($results[0]['warehouses']) > 0) {
            $specificSlabs = $results[0]['warehouses'][0]['slabs_on_hand'];
        }

        return [
            'found' => true,
            'query' => [
                'product' => $productQuery,
                'warehouse' => $warehouseQuery,
                'thickness_cm' => $thickness,
            ],
            'resolved_warehouse' => $warehouse ? $warehouse->city : 'All Warehouses',
            'specific_slabs_on_hand' => $specificSlabs,
            'results' => $results,
        ];
    }

    protected function extractThickness(?string $query): ?float
    {
        if (empty($query)) return null;

        if (preg_match('/(\d+(\.\d+)?)\s*cm/i', $query, $matches)) {
            return (float) $matches[1];
        }

        return null;
    }

    protected function cleanProductQuery(?string $query): string
    {
        if (empty($query)) return '';

        // Strip "3cm", "2cm", "slabs", "slab" for clean product name searching
        $cleaned = preg_replace('/\b\d+(\.\d+)?\s*cm\b/i', '', $query);
        $cleaned = preg_replace('/\b(slabs?|in stock|stock|do we have|how many)\b/i', '', $cleaned);

        return trim($cleaned);
    }
}
