<?php

namespace Database\Seeders;

use App\Models\Product;
use App\Models\PurchaseOrder;
use App\Models\PurchaseOrderLine;
use App\Models\Stock;
use App\Models\Supplier;
use App\Models\User;
use App\Models\Warehouse;
use Carbon\Carbon;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Hash;

class DatabaseSeeder extends Seeder
{
    public function run(): void
    {
        // 1. Ensure Users (Sales & Purchasing) always exist with valid credentials
        User::updateOrCreate(
            ['email' => 'sales@example.com'],
            [
                'name' => 'Sarah Jenkins (Sales)',
                'password' => Hash::make('password123'),
                'role' => User::ROLE_SALES,
            ]
        );

        User::updateOrCreate(
            ['email' => 'purchasing@example.com'],
            [
                'name' => 'Peter Vance (Purchasing)',
                'password' => Hash::make('password123'),
                'role' => User::ROLE_PURCHASING,
            ]
        );

        // Check if ERP inventory and purchase orders are already seeded
        if (Product::where('sku', 'CAL-3CM-001')->exists()) {
            $this->command?->info('Database is already seeded with ERP inventory and purchase orders. Skipping inventory seeder.');
            return;
        }

        // 2. Create Warehouses (Houston, Dallas, Chicago)
        $warehouses = [
            'Houston' => Warehouse::create(['name' => 'Houston Regional Distribution Center', 'city' => 'Houston']),
            'Dallas'  => Warehouse::create(['name' => 'Dallas Central Depot', 'city' => 'Dallas']),
            'Chicago' => Warehouse::create(['name' => 'Chicago Midwest Warehouse', 'city' => 'Chicago']),
        ];

        // 3. Create Suppliers (including Supplier X and Supplier Y)
        $suppliers = [
            'Supplier X' => Supplier::create([
                'name' => 'Supplier X',
                'contact' => 'John Smith (john@supplier-x.com, +1-555-0101)',
                'payment_terms' => 'Net 30',
                'bank_details' => 'Chase Bank | Routing: 021000021 | Account: 9876543210 | Swift: CHASUS33',
            ]),
            'Supplier Y' => Supplier::create([
                'name' => 'Supplier Y',
                'contact' => 'Maria Rossi (maria@supplier-y.com, +1-555-0102)',
                'payment_terms' => 'Net 60',
                'bank_details' => 'Wells Fargo | Routing: 122000496 | Account: 4455667788 | Swift: WFBIUS6S',
            ]),
            'Apex Stone Imports' => Supplier::create([
                'name' => 'Apex Stone Imports',
                'contact' => 'Carlos Santana (carlos@apexstone.com, +1-555-0103)',
                'payment_terms' => 'Net 45',
                'bank_details' => 'Bank of America | Routing: 111000025 | Account: 1234567890 | Swift: BOFAUS3N',
            ]),
            'Verona Marble Co' => Supplier::create([
                'name' => 'Verona Marble Co',
                'contact' => 'Alessandro Conti (alessandro@veronamarble.it, +39-045-5550104)',
                'payment_terms' => 'Net 30',
                'bank_details' => 'UniCredit Italy | IBAN: IT60X0542811101000000123456 | BIC: UNCRITM1',
            ]),
            'Quarzo Surfaces LLC' => Supplier::create([
                'name' => 'Quarzo Surfaces LLC',
                'contact' => 'Emily Chen (schen@quarzosurfaces.com, +1-555-0105)',
                'payment_terms' => 'Net 30',
                'bank_details' => 'Citibank NA | Routing: 071000013 | Account: 5566778899 | Swift: CITIUS33',
            ]),
        ];

        // 4. Create 22 Realistic Stone & Quartz Products
        $productsData = [
            // Exact products matching prompt examples
            [
                'sku' => 'CAL-3CM-001',
                'name' => 'Calacatta Gold',
                'material' => 'Marble',
                'color' => 'White/Gold',
                'thickness_cm' => 3.0,
                'slab_size' => '126x63 in',
                'stock' => ['Houston' => 42, 'Dallas' => 18, 'Chicago' => 10], // Matches brief conversation exactly!
            ],
            [
                'sku' => 'CAR-2CM-002',
                'name' => 'Carrara White',
                'material' => 'Marble',
                'color' => 'White/Grey',
                'thickness_cm' => 2.0,
                'slab_size' => '120x60 in',
                'stock' => ['Houston' => 25, 'Dallas' => 30, 'Chicago' => 15],
            ],
            [
                'sku' => 'CAL-2CM-003',
                'name' => 'Calacatta Gold',
                'material' => 'Marble',
                'color' => 'White/Gold',
                'thickness_cm' => 2.0,
                'slab_size' => '126x63 in',
                'stock' => ['Houston' => 14, 'Dallas' => 8, 'Chicago' => 5],
            ],
            [
                'sku' => 'CAR-3CM-004',
                'name' => 'Carrara White',
                'material' => 'Marble',
                'color' => 'White/Grey',
                'thickness_cm' => 3.0,
                'slab_size' => '120x60 in',
                'stock' => ['Houston' => 20, 'Dallas' => 22, 'Chicago' => 12],
            ],
            [
                'sku' => 'STA-2CM-005',
                'name' => 'Statuario Premium',
                'material' => 'Marble',
                'color' => 'Pure White/Bold Grey',
                'thickness_cm' => 2.0,
                'slab_size' => '128x65 in',
                'stock' => ['Houston' => 12, 'Dallas' => 16, 'Chicago' => 8],
            ],
            [
                'sku' => 'STA-3CM-006',
                'name' => 'Statuario Premium',
                'material' => 'Marble',
                'color' => 'Pure White/Bold Grey',
                'thickness_cm' => 3.0,
                'slab_size' => '128x65 in',
                'stock' => ['Houston' => 9, 'Dallas' => 14, 'Chicago' => 6],
            ],
            [
                'sku' => 'TAJ-3CM-007',
                'name' => 'Taj Mahal',
                'material' => 'Quartzite',
                'color' => 'Cream/Amber',
                'thickness_cm' => 3.0,
                'slab_size' => '130x70 in',
                'stock' => ['Houston' => 35, 'Dallas' => 28, 'Chicago' => 19],
            ],
            [
                'sku' => 'BLK-3CM-008',
                'name' => 'Black Galaxy',
                'material' => 'Granite',
                'color' => 'Black with Gold Flecks',
                'thickness_cm' => 3.0,
                'slab_size' => '120x65 in',
                'stock' => ['Houston' => 50, 'Dallas' => 45, 'Chicago' => 30],
            ],
            [
                'sku' => 'MAC-3CM-009',
                'name' => 'White Macaubas',
                'material' => 'Quartzite',
                'color' => 'White/Linear Grey',
                'thickness_cm' => 3.0,
                'slab_size' => '124x64 in',
                'stock' => ['Houston' => 16, 'Dallas' => 12, 'Chicago' => 10],
            ],
            [
                'sku' => 'BLU-3CM-010',
                'name' => 'Blue Pearl',
                'material' => 'Granite',
                'color' => 'Metallic Blue/Silver',
                'thickness_cm' => 3.0,
                'slab_size' => '118x60 in',
                'stock' => ['Houston' => 22, 'Dallas' => 19, 'Chicago' => 14],
            ],
            [
                'sku' => 'SUP-2CM-011',
                'name' => 'Super White',
                'material' => 'Dolomite',
                'color' => 'Light Grey/Pewter',
                'thickness_cm' => 2.0,
                'slab_size' => '122x62 in',
                'stock' => ['Houston' => 18, 'Dallas' => 15, 'Chicago' => 9],
            ],
            [
                'sku' => 'NUV-2CM-012',
                'name' => 'Calacatta Nuvo',
                'material' => 'Quartz',
                'color' => 'Ivory/Soft Grey Vein',
                'thickness_cm' => 2.0,
                'slab_size' => '126x63 in',
                'stock' => ['Houston' => 40, 'Dallas' => 35, 'Chicago' => 28],
            ],
            [
                'sku' => 'PUR-3CM-013',
                'name' => 'Pure White Quartz',
                'material' => 'Quartz',
                'color' => 'Ultra White',
                'thickness_cm' => 3.0,
                'slab_size' => '126x63 in',
                'stock' => ['Houston' => 60, 'Dallas' => 55, 'Chicago' => 45],
            ],
            [
                'sku' => 'CON-2CM-014',
                'name' => 'Concrete Matte',
                'material' => 'Quartz',
                'color' => 'Industrial Grey',
                'thickness_cm' => 2.0,
                'slab_size' => '126x63 in',
                'stock' => ['Houston' => 20, 'Dallas' => 18, 'Chicago' => 15],
            ],
            [
                'sku' => 'EMP-3CM-015',
                'name' => 'Emperador Dark',
                'material' => 'Marble',
                'color' => 'Rich Brown/Spider Veining',
                'thickness_cm' => 3.0,
                'slab_size' => '115x60 in',
                'stock' => ['Houston' => 15, 'Dallas' => 10, 'Chicago' => 8],
            ],
            [
                'sku' => 'PAT-3CM-016',
                'name' => 'Patagonia Translucent',
                'material' => 'Quartzite',
                'color' => 'Cream/Smoky Crystal',
                'thickness_cm' => 3.0,
                'slab_size' => '130x68 in',
                'stock' => ['Houston' => 8, 'Dallas' => 6, 'Chicago' => 4],
            ],
            [
                'sku' => 'CRI-3CM-017',
                'name' => 'Cristallo Quartzite',
                'material' => 'Quartzite',
                'color' => 'Translucent White/Gold',
                'thickness_cm' => 3.0,
                'slab_size' => '128x66 in',
                'stock' => ['Houston' => 11, 'Dallas' => 9, 'Chicago' => 5],
            ],
            [
                'sku' => 'ARC-2CM-018',
                'name' => 'Arctic Frost',
                'material' => 'Quartz',
                'color' => 'Crisp White/Fine Grain',
                'thickness_cm' => 2.0,
                'slab_size' => '126x63 in',
                'stock' => ['Houston' => 32, 'Dallas' => 25, 'Chicago' => 20],
            ],
            [
                'sku' => 'PIE-2CM-019',
                'name' => 'Pietra Grey',
                'material' => 'Marble',
                'color' => 'Charcoal/White Accent',
                'thickness_cm' => 2.0,
                'slab_size' => '120x60 in',
                'stock' => ['Houston' => 17, 'Dallas' => 14, 'Chicago' => 11],
            ],
            [
                'sku' => 'FAN-3CM-020',
                'name' => 'Fantasy Brown',
                'material' => 'Marble',
                'color' => 'Warm Brown/Cream Swirl',
                'thickness_cm' => 3.0,
                'slab_size' => '125x65 in',
                'stock' => ['Houston' => 28, 'Dallas' => 24, 'Chicago' => 18],
            ],
            [
                'sku' => 'ABS-3CM-021',
                'name' => 'Absolute Black',
                'material' => 'Granite',
                'color' => 'Pitch Black Polished',
                'thickness_cm' => 3.0,
                'slab_size' => '120x62 in',
                'stock' => ['Houston' => 45, 'Dallas' => 38, 'Chicago' => 30],
            ],
            [
                'sku' => 'SOP-3CM-022',
                'name' => 'Soapstone Charcoal',
                'material' => 'Soapstone',
                'color' => 'Dark Slate Grey',
                'thickness_cm' => 3.0,
                'slab_size' => '110x55 in',
                'stock' => ['Houston' => 10, 'Dallas' => 8, 'Chicago' => 7],
            ],
        ];

        $createdProducts = [];
        foreach ($productsData as $item) {
            $product = Product::create([
                'sku' => $item['sku'],
                'name' => $item['name'],
                'material' => $item['material'],
                'color' => $item['color'],
                'thickness_cm' => $item['thickness_cm'],
                'slab_size' => $item['slab_size'],
            ]);
            $createdProducts[$item['sku']] = $product;

            foreach ($item['stock'] as $city => $qty) {
                Stock::create([
                    'product_id' => $product->id,
                    'warehouse_id' => $warehouses[$city]->id,
                    'slabs_on_hand' => $qty,
                ]);
            }
        }

        // 5. Create 15 Purchase Orders (including PO-1023 and delayed POs from Supplier X)
        $today = Carbon::today();

        // PO-1023 (Referenced in challenge conversation prompt)
        $po1023 = PurchaseOrder::create([
            'po_number' => 'PO-1023',
            'supplier_id' => $suppliers['Supplier Y']->id,
            'status' => 'confirmed',
            'order_date' => $today->copy()->subDays(20),
            'eta' => $today->copy()->addDays(15),
            'freight_cost' => 1500.00,
            'notes' => 'Container shipment arriving via Port of Houston',
        ]);
        PurchaseOrderLine::create([
            'purchase_order_id' => $po1023->id,
            'product_id' => $createdProducts['CAL-3CM-001']->id, // Calacatta Gold 3cm
            'quantity' => 30,
            'unit_cost' => 120.00,
        ]);
        PurchaseOrderLine::create([
            'purchase_order_id' => $po1023->id,
            'product_id' => $createdProducts['CAR-2CM-002']->id, // Carrara White 2cm
            'quantity' => 20,
            'unit_cost' => 85.00,
        ]);

        // POs for Supplier X (including delayed POs past ETA, as explicitly asked in challenge)
        $po1010 = PurchaseOrder::create([
            'po_number' => 'PO-1010',
            'supplier_id' => $suppliers['Supplier X']->id,
            'status' => 'delayed',
            'order_date' => $today->copy()->subDays(60),
            'eta' => $today->copy()->subDays(14), // In the past! Delayed!
            'freight_cost' => 1200.00,
            'notes' => 'Customs delay at port of entry. Supplier notified.',
        ]);
        PurchaseOrderLine::create([
            'purchase_order_id' => $po1010->id,
            'product_id' => $createdProducts['BLK-3CM-008']->id,
            'quantity' => 25,
            'unit_cost' => 95.00,
        ]);

        $po1012 = PurchaseOrder::create([
            'po_number' => 'PO-1012',
            'supplier_id' => $suppliers['Supplier X']->id,
            'status' => 'delayed',
            'order_date' => $today->copy()->subDays(45),
            'eta' => $today->copy()->subDays(5), // In the past! Delayed!
            'freight_cost' => 900.00,
            'notes' => 'Vessel rescheduled arrival due to severe weather.',
        ]);
        PurchaseOrderLine::create([
            'purchase_order_id' => $po1012->id,
            'product_id' => $createdProducts['SUP-2CM-011']->id,
            'quantity' => 20,
            'unit_cost' => 110.00,
        ]);

        $po1015 = PurchaseOrder::create([
            'po_number' => 'PO-1015',
            'supplier_id' => $suppliers['Supplier X']->id,
            'status' => 'confirmed',
            'order_date' => $today->copy()->subDays(10),
            'eta' => $today->copy()->addDays(20),
            'freight_cost' => 1100.00,
            'notes' => 'On schedule for delivery to Dallas depot.',
        ]);
        PurchaseOrderLine::create([
            'purchase_order_id' => $po1015->id,
            'product_id' => $createdProducts['BLU-3CM-010']->id,
            'quantity' => 18,
            'unit_cost' => 130.00,
        ]);

        // Additional POs across suppliers (total 15 POs)
        $otherPOs = [
            [
                'po' => 'PO-1001', 'supplier' => 'Apex Stone Imports', 'status' => 'received',
                'order_date' => $today->copy()->subDays(90), 'eta' => $today->copy()->subDays(30),
                'freight' => 1400.00, 'items' => [['sku' => 'TAJ-3CM-007', 'qty' => 20, 'cost' => 175.00]]
            ],
            [
                'po' => 'PO-1002', 'supplier' => 'Verona Marble Co', 'status' => 'received',
                'order_date' => $today->copy()->subDays(80), 'eta' => $today->copy()->subDays(25),
                'freight' => 1800.00, 'items' => [['sku' => 'STA-2CM-005', 'qty' => 15, 'cost' => 210.00], ['sku' => 'STA-3CM-006', 'qty' => 10, 'cost' => 260.00]]
            ],
            [
                'po' => 'PO-1003', 'supplier' => 'Quarzo Surfaces LLC', 'status' => 'confirmed',
                'order_date' => $today->copy()->subDays(12), 'eta' => $today->copy()->addDays(18),
                'freight' => 850.00, 'items' => [['sku' => 'PUR-3CM-013', 'qty' => 40, 'cost' => 70.00]]
            ],
            [
                'po' => 'PO-1004', 'supplier' => 'Apex Stone Imports', 'status' => 'delayed',
                'order_date' => $today->copy()->subDays(50), 'eta' => $today->copy()->subDays(8), // Delayed past ETA
                'freight' => 1350.00, 'items' => [['sku' => 'MAC-3CM-009', 'qty' => 22, 'cost' => 160.00]]
            ],
            [
                'po' => 'PO-1005', 'supplier' => 'Supplier Y', 'status' => 'draft',
                'order_date' => $today->copy()->subDays(2), 'eta' => $today->copy()->addDays(35),
                'freight' => 1000.00, 'items' => [['sku' => 'CAR-3CM-004', 'qty' => 15, 'cost' => 105.00]]
            ],
            [
                'po' => 'PO-1006', 'supplier' => 'Verona Marble Co', 'status' => 'confirmed',
                'order_date' => $today->copy()->subDays(15), 'eta' => $today->copy()->addDays(22),
                'freight' => 1650.00, 'items' => [['sku' => 'EMP-3CM-015', 'qty' => 12, 'cost' => 140.00], ['sku' => 'PIE-2CM-019', 'qty' => 18, 'cost' => 115.00]]
            ],
            [
                'po' => 'PO-1007', 'supplier' => 'Quarzo Surfaces LLC', 'status' => 'confirmed',
                'order_date' => $today->copy()->subDays(8), 'eta' => $today->copy()->addDays(25),
                'freight' => 950.00, 'items' => [['sku' => 'CON-2CM-014', 'qty' => 25, 'cost' => 80.00], ['sku' => 'ARC-2CM-018', 'qty' => 30, 'cost' => 75.00]]
            ],
            [
                'po' => 'PO-1008', 'supplier' => 'Apex Stone Imports', 'status' => 'confirmed',
                'order_date' => $today->copy()->subDays(5), 'eta' => $today->copy()->addDays(30),
                'freight' => 2100.00, 'items' => [['sku' => 'PAT-3CM-016', 'qty' => 8, 'cost' => 350.00], ['sku' => 'CRI-3CM-017', 'qty' => 10, 'cost' => 320.00]]
            ],
            [
                'po' => 'PO-1009', 'supplier' => 'Supplier X', 'status' => 'received',
                'order_date' => $today->copy()->subDays(100), 'eta' => $today->copy()->subDays(40),
                'freight' => 1100.00, 'items' => [['sku' => 'ABS-3CM-021', 'qty' => 35, 'cost' => 88.00]]
            ],
            [
                'po' => 'PO-1011', 'supplier' => 'Verona Marble Co', 'status' => 'delayed',
                'order_date' => $today->copy()->subDays(40), 'eta' => $today->copy()->subDays(10), // Delayed past ETA
                'freight' => 1250.00, 'items' => [['sku' => 'CAL-2CM-003', 'qty' => 14, 'cost' => 145.00]]
            ],
            [
                'po' => 'PO-1014', 'supplier' => 'Quarzo Surfaces LLC', 'status' => 'draft',
                'order_date' => $today->copy()->subDays(1), 'eta' => $today->copy()->addDays(40),
                'freight' => 800.00, 'items' => [['sku' => 'NUV-2CM-012', 'qty' => 20, 'cost' => 92.00]]
            ],
        ];

        foreach ($otherPOs as $item) {
            $po = PurchaseOrder::create([
                'po_number' => $item['po'],
                'supplier_id' => $suppliers[$item['supplier']]->id,
                'status' => $item['status'],
                'order_date' => $item['order_date'],
                'eta' => $item['eta'],
                'freight_cost' => $item['freight'],
                'notes' => 'Standard shipment order.',
            ]);

            foreach ($item['items'] as $line) {
                PurchaseOrderLine::create([
                    'purchase_order_id' => $po->id,
                    'product_id' => $createdProducts[$line['sku']]->id,
                    'quantity' => $line['qty'],
                    'unit_cost' => $line['cost'],
                ]);
            }
        }
    }
}
