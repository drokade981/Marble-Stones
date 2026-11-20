<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('draft_purchase_orders', function (Blueprint $table) {
            $table->id();
            $table->string('draft_token')->unique();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->foreignId('supplier_id')->constrained()->cascadeOnDelete();
            $table->json('items'); // [{product_id, quantity, unit_cost}]
            $table->decimal('estimated_freight', 10, 2)->default(0.00);
            $table->string('status')->default('pending_confirmation'); // pending_confirmation, confirmed, discarded
            $table->text('summary_text');
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('draft_purchase_orders');
    }
};
