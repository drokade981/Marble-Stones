<?php

namespace Tests\Feature;

use App\Models\User;
use Database\Seeders\DatabaseSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class RolePermissionsTest extends TestCase
{
    use RefreshDatabase;

    protected User $salesUser;
    protected User $purchasingUser;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(DatabaseSeeder::class);

        $this->salesUser = User::where('email', 'sales@example.com')->first();
        $this->purchasingUser = User::where('email', 'purchasing@example.com')->first();
    }

    public function test_sales_user_cannot_call_landed_cost_tool_directly(): void
    {
        $response = $this->actingAs($this->salesUser, 'sanctum')
            ->postJson('/api/tools/get-landed-cost', [
                'po_number' => 'PO-1023',
            ]);

        $response->assertStatus(403)
            ->assertJsonPath('allowed', false)
            ->assertJsonPath('polite_refusal', 'Cost details are only available to the Purchasing team.');
    }

    public function test_purchasing_user_can_call_landed_cost_tool_directly(): void
    {
        $response = $this->actingAs($this->purchasingUser, 'sanctum')
            ->postJson('/api/tools/get-landed-cost', [
                'po_number' => 'PO-1023',
            ]);

        $response->assertStatus(200)
            ->assertJsonPath('allowed', true)
            ->assertJsonPath('data.po_number', 'PO-1023')
            ->assertJsonPath('data.total_slabs', 50)
            ->assertJsonPath('data.freight_share_per_slab', 30);
    }

    public function test_sales_user_cannot_create_draft_po(): void
    {
        $response = $this->actingAs($this->salesUser, 'sanctum')
            ->postJson('/api/tools/create-draft-po', [
                'supplier_name' => 'Supplier Y',
                'items' => [
                    ['product' => '2cm Carrara', 'quantity' => 20],
                ],
            ]);

        $response->assertStatus(403)
            ->assertJsonPath('allowed', false);
    }

    public function test_purchasing_user_can_create_draft_po_and_confirm(): void
    {
        // 1. Create Draft
        $draftRes = $this->actingAs($this->purchasingUser, 'sanctum')
            ->postJson('/api/tools/create-draft-po', [
                'supplier_name' => 'Supplier Y',
                'items' => [
                    ['product' => '2cm Carrara', 'quantity' => 20, 'unit_cost' => 85.00],
                ],
                'estimated_freight' => 500.00,
            ]);

        $draftRes->assertStatus(200)
            ->assertJsonPath('status', 'draft_pending_confirmation');

        $draftToken = $draftRes->json('draft_token');
        $this->assertNotEmpty($draftToken);

        // 2. Confirm Draft
        $confirmRes = $this->actingAs($this->purchasingUser, 'sanctum')
            ->postJson('/api/tools/confirm-draft-po', [
                'draft_token' => $draftToken,
            ]);

        $confirmRes->assertStatus(200)
            ->assertJsonPath('status', 'saved');
        $this->assertStringStartsWith('PO-', $confirmRes->json('po_number'));
    }

    public function test_sales_user_po_search_masks_costs(): void
    {
        $response = $this->actingAs($this->salesUser, 'sanctum')
            ->postJson('/api/tools/search-purchase-orders', [
                'po_number' => 'PO-1023',
            ]);

        $response->assertStatus(200);
        $order = $response->json('purchase_orders.0');
        $this->assertEquals('PO-1023', $order['po_number']);
        $this->assertArrayNotHasKey('freight_cost', $order);
        $this->assertArrayNotHasKey('total_amount', $order);
        $this->assertArrayNotHasKey('supplier_bank_details', $order);
    }

    public function test_purchasing_user_po_search_includes_costs(): void
    {
        $response = $this->actingAs($this->purchasingUser, 'sanctum')
            ->postJson('/api/tools/search-purchase-orders', [
                'po_number' => 'PO-1023',
            ]);

        $response->assertStatus(200);
        $order = $response->json('purchase_orders.0');
        $this->assertEquals('PO-1023', $order['po_number']);
        $this->assertArrayHasKey('freight_cost', $order);
        $this->assertArrayHasKey('total_amount', $order);
        $this->assertArrayHasKey('supplier_bank_details', $order);
    }

    public function test_sales_user_cannot_see_draft_purchase_orders(): void
    {
        // 1. Create a draft PO with purchasing user
        $draftRes = $this->actingAs($this->purchasingUser, 'sanctum')
            ->postJson('/api/tools/create-draft-po', [
                'supplier_name' => 'Supplier Y',
                'items' => [
                    ['product' => '2cm Carrara', 'quantity' => 15, 'unit_cost' => 80.00],
                ],
            ]);
        $draftToken = $draftRes->json('draft_token');
        $this->assertNotEmpty($draftToken);

        // 2. Sales user attempts to confirm draft PO -> Forbidden 403
        $confirmRes = $this->actingAs($this->salesUser, 'sanctum')
            ->postJson('/api/tools/confirm-draft-po', [
                'draft_token' => $draftToken,
            ]);
        $confirmRes->assertStatus(403)
            ->assertJsonPath('allowed', false);

        // 3. Sales user searches purchase orders -> draft orders are filtered out
        $searchRes = $this->actingAs($this->salesUser, 'sanctum')
            ->postJson('/api/tools/search-purchase-orders', []);
        $searchRes->assertStatus(200);
        $orders = $searchRes->json('purchase_orders');
        foreach ($orders as $order) {
            $this->assertNotEquals('draft', strtolower($order['status']));
        }

        // 4. Sales user GET /api/purchase-orders -> draft orders are filtered out
        $listRes = $this->actingAs($this->salesUser, 'sanctum')
            ->getJson('/api/purchase-orders');
        $listRes->assertStatus(200);
        $poList = $listRes->json();
        foreach ($poList as $po) {
            $this->assertNotEquals('draft', strtolower($po['status']));
        }
    }
}

