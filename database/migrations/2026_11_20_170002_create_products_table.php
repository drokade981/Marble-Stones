<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('products', function (Blueprint $table) {
            $table->id();
            $table->string('sku')->unique();
            $table->string('name');
            $table->string('material'); // e.g. Marble, Quartz, Granite, Quartzite, Porcelain
            $table->string('color');
            $table->decimal('thickness_cm', 4, 1); // e.g. 2.0, 3.0
            $table->string('slab_size'); // e.g. "126x63 in"
            $table->timestamps();

            $table->index(['name', 'thickness_cm']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('products');
    }
};

