<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class AssistantLog extends Model
{
    use HasFactory;

    protected $fillable = [
        'user_id',
        'conversation_id',
        'question',
        'tools_called',
        'final_answer',
        'tokens_used',
        'response_time_ms',
        'provider',
    ];

    protected function casts(): array
    {
        return [
            'tools_called' => 'array',
            'tokens_used' => 'integer',
            'response_time_ms' => 'integer',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
