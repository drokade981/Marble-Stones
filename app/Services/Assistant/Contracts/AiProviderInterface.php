<?php

namespace App\Services\Assistant\Contracts;

use App\Models\User;

interface AiProviderInterface
{
    /**
     * Given user message, history, and available tool definitions, decide next action (call tools or return final response).
     *
     * @param string $message
     * @param array $history
     * @param array $tools
     * @param User $user
     * @return array
     */
    public function generateResponse(string $message, array $history, array $tools, User $user): array;

    /**
     * Synthesize a final plain-English answer given the original message, history, and tool execution results.
     *
     * @param string $message
     * @param array $history
     * @param array $toolResults
     * @param User $user
     * @return array ['text' => string, 'tokens' => int]
     */
    public function synthesizeAnswer(string $message, array $history, array $toolResults, User $user): array;

    public function getProviderName(): string;
}

