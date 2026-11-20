<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class DraftPurchaseOrder extends Model
{
    use HasFactory;

    protected $fillable = [
        'draft_token',
        'user_id',
        'supplier_id',
        'items',
        'estimated_freight',
        'status',
        'summary_text',
    ];

    protected function casts(): array
    {
        return [
            'items' => 'array',
            'estimated_freight' => 'decimal:2',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public function supplier(): BelongsTo
    {
        return $this->belongsTo(Supplier::class);
    }
}

