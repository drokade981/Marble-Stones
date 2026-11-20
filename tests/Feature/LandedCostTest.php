<?php

namespace Tests\Feature;

use App\Models\PurchaseOrder;
use App\Services\LandedCostService;
use Database\Seeders\DatabaseSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class LandedCostTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(DatabaseSeeder::class);
    }

    public function test_landed_cost_calculation_per_slab(): void
    {
        $po1023 = PurchaseOrder::where('po_number', 'PO-1023')->first();
        $service = app(LandedCostService::class);

        $result = $service->calculateForPurchaseOrder($po1023);

        // PO-1023 has 30 slabs Calacatta ($120/slab) + 20 slabs Carrara ($85/slab) = 50 total slabs
        // Freight is $1500.00
        // Freight per slab = $1500 / 50 = $30.00 per slab
        $this->assertEquals(50, $result['total_slabs']);
        $this->assertEquals(1500.00, $result['freight_cost']);
        $this->assertEquals(30.00, $result['freight_share_per_slab']);

        // Line 1: Calacatta ($120 + $30 = $150)
        $this->assertEquals(150.00, $result['lines'][0]['landed_cost_per_slab']);

        // Line 2: Carrara ($85 + $30 = $115)
        $this->assertEquals(115.00, $result['lines'][1]['landed_cost_per_slab']);

        // Total product cost: (30 * 120) + (20 * 85) = 3600 + 1700 = 5300
        $this->assertEquals(5300.00, $result['total_product_cost']);
        // Total landed cost: 5300 + 1500 = 6800
        $this->assertEquals(6800.00, $result['total_landed_cost']);
    }
}

