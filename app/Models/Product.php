<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Product extends Model
{
    use HasFactory;

    protected $fillable = [
        'sku',
        'name',
        'material',
        'color',
        'thickness_cm',
        'slab_size',
    ];

    protected function casts(): array
    {
        return [
            'thickness_cm' => 'float',
        ];
    }

    public function stocks(): HasMany
    {
        return $this->hasMany(Stock::class);
    }

    public function warehouses(): BelongsToMany
    {
        return $this->belongsToMany(Warehouse::class, 'stock')
            ->withPivot('slabs_on_hand')
            ->withTimestamps();
    }

    public function purchaseOrderLines(): HasMany
    {
        return $this->hasMany(PurchaseOrderLine::class);
    }

    public function getTotalSlabsOnHandAttribute(): int
    {
        return (int) $this->stocks()->sum('slabs_on_hand');
    }
}
