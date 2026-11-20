<?php

namespace App\Services\Assistant;

use Illuminate\Support\Facades\Cache;

class ConversationContext
{
    protected string $conversationId;
    protected array $data = [];

    public function __construct(string $conversationId)
    {
        $this->conversationId = $conversationId;
        $this->load();
    }

    public static function for(string $conversationId): self
    {
        return new self($conversationId);
    }

    protected function cacheKey(): string
    {
        return "assistant_ctx_{$this->conversationId}";
    }

    protected function load(): void
    {
        $this->data = Cache::get($this->cacheKey(), [
            'history' => [],
            'last_product' => null,
            'last_thickness' => null,
            'last_warehouse' => null,
            'last_supplier' => null,
            'last_po_number' => null,
            'pending_draft_token' => null,
            'updated_at' => now()->toIso8601String(),
        ]);
    }

    public function save(): void
    {
        $this->data['updated_at'] = now()->toIso8601String();
        // Keep context active for 2 hours
        Cache::put($this->cacheKey(), $this->data, now()->addHours(2));
    }

    public function getHistory(int $limit = 6): array
    {
        $history = $this->data['history'] ?? [];
        return array_slice($history, -$limit);
    }

    public function addTurn(string $userMessage, string $assistantReply, array $toolsCalled = []): void
    {
        $this->data['history'][] = [
            'user' => $userMessage,
            'assistant' => $assistantReply,
            'tools' => $toolsCalled,
            'timestamp' => now()->toIso8601String(),
        ];

        // Keep last 15 turns in memory
        if (count($this->data['history']) > 15) {
            array_shift($this->data['history']);
        }

        $this->save();
    }

    public function setLastProduct(?string $product, ?float $thickness = null): void
    {
        if ($product) {
            $this->data['last_product'] = $product;
        }
        if ($thickness !== null) {
            $this->data['last_thickness'] = $thickness;
        }
        $this->save();
    }

    public function getLastProduct(): ?string
    {
        return $this->data['last_product'] ?? null;
    }

    public function getLastThickness(): ?float
    {
        return isset($this->data['last_thickness']) ? (float) $this->data['last_thickness'] : null;
    }

    public function setLastWarehouse(?string $warehouse): void
    {
        if ($warehouse) {
            $this->data['last_warehouse'] = $warehouse;
            $this->save();
        }
    }

    public function getLastWarehouse(): ?string
    {
        return $this->data['last_warehouse'] ?? null;
    }

    public function setLastPoNumber(?string $poNumber): void
    {
        if ($poNumber) {
            $this->data['last_po_number'] = $poNumber;
            $this->save();
        }
    }

    public function getLastPoNumber(): ?string
    {
        return $this->data['last_po_number'] ?? null;
    }

    public function setPendingDraftToken(?string $token): void
    {
        $this->data['pending_draft_token'] = $token;
        $this->save();
    }

    public function getPendingDraftToken(): ?string
    {
        return $this->data['pending_draft_token'] ?? null;
    }

    public function clearPendingDraft(): void
    {
        $this->data['pending_draft_token'] = null;
        $this->save();
    }
}

