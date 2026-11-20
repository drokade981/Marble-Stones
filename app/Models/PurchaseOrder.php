<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class PurchaseOrder extends Model
{
    use HasFactory;

    protected $fillable = [
        'po_number',
        'supplier_id',
        'status',
        'order_date',
        'eta',
        'freight_cost',
        'notes',
    ];

    protected function casts(): array
    {
        return [
            'order_date' => 'date',
            'eta' => 'date',
            'freight_cost' => 'decimal:2',
        ];
    }

    public function supplier(): BelongsTo
    {
        return $this->belongsTo(Supplier::class);
    }

    public function lines(): HasMany
    {
        return $this->hasMany(PurchaseOrderLine::class);
    }

    public function getTotalSlabsAttribute(): int
    {
        return (int) $this->lines->sum('quantity');
    }

    public function getTotalProductCostAttribute(): float
    {
        return (float) $this->lines->sum(fn ($line) => $line->quantity * $line->unit_cost);
    }

    public function getTotalLandedCostAttribute(): float
    {
        return $this->total_product_cost + (float) $this->freight_cost;
    }

    public function isDelayed(): bool
    {
        if ($this->status === 'delayed') {
            return true;
        }

        if ($this->status !== 'received' && $this->status !== 'cancelled' && $this->eta->isPast()) {
            return true;
        }

        return false;
    }
}

