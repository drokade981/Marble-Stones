<?php

namespace App\Services;

use App\Models\PurchaseOrder;

class LandedCostService
{
    /**
     * Calculate landed cost per slab for a purchase order.
     * Freight is allocated proportionally per slab (quantity-based).
     *
     * Why quantity-based allocation:
     * In the stone and quartz industry, slabs are heavy freight items shipped in standardized
     * A-frames inside shipping containers. Ocean and overland freight rates are governed primarily
     * by physical container weight limits and slab capacities rather than stone market valuation.
     * Dividing freight evenly across all slabs in the shipment accurately mirrors true logistics costs.
     */
    public function calculateForPurchaseOrder(PurchaseOrder $po): array
    {
        $po->loadMissing(['lines.product', 'supplier']);

        $totalSlabs = (int) $po->lines->sum('quantity');
        $freightCost = (float) $po->freight_cost;
        $freightPerSlab = $totalSlabs > 0 ? round($freightCost / $totalSlabs, 2) : 0.00;

        $lines = [];
        $totalProductCost = 0.0;

        foreach ($po->lines as $line) {
            $unitCost = (float) $line->unit_cost;
            $quantity = (int) $line->quantity;
            $landedCostPerSlab = round($unitCost + $freightPerSlab, 2);
            $lineTotalLandedCost = round($landedCostPerSlab * $quantity, 2);
            $totalProductCost += ($unitCost * $quantity);

            $lines[] = [
                'line_id' => $line->id,
                'product_id' => $line->product_id,
                'sku' => $line->product->sku ?? 'N/A',
                'product_name' => $line->product->name ?? 'Unknown',
                'thickness_cm' => $line->product->thickness_cm ?? null,
                'quantity' => $quantity,
                'unit_cost' => $unitCost,
                'freight_share_per_slab' => $freightPerSlab,
                'landed_cost_per_slab' => $landedCostPerSlab,
                'total_line_landed_cost' => $lineTotalLandedCost,
            ];
        }

        $totalLandedCost = round($totalProductCost + $freightCost, 2);

        return [
            'po_number' => $po->po_number,
            'supplier' => $po->supplier->name ?? 'Unknown',
            'status' => $po->status,
            'order_date' => $po->order_date?->toDateString(),
            'eta' => $po->eta?->toDateString(),
            'total_slabs' => $totalSlabs,
            'freight_cost' => $freightCost,
            'freight_allocation_method' => 'Per-slab quantity basis (freight_cost / total_slabs)',
            'freight_share_per_slab' => $freightPerSlab,
            'total_product_cost' => round($totalProductCost, 2),
            'total_landed_cost' => $totalLandedCost,
            'lines' => $lines,
        ];
    }
}
