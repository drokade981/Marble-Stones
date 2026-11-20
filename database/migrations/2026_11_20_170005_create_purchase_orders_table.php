<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('purchase_orders', function (Blueprint $table) {
            $table->id();
            $table->string('po_number')->unique(); // e.g. PO-1023
            $table->foreignId('supplier_id')->constrained()->cascadeOnDelete();
            $table->string('status'); // draft, confirmed, delayed, received, cancelled
            $table->date('order_date');
            $table->date('eta');
            $table->decimal('freight_cost', 10, 2)->default(0.00);
            $table->text('notes')->nullable();
            $table->timestamps();

            $table->index(['supplier_id', 'status']);
            $table->index('eta');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('purchase_orders');
    }
};
