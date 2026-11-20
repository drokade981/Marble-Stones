<?php

namespace App\Services\Assistant;

use App\Models\AssistantLog;
use App\Models\User;
use App\Services\Assistant\Contracts\AiProviderInterface;
use App\Services\Assistant\Providers\AnthropicProvider;
use App\Services\Assistant\Providers\LocalHeuristicProvider;
use App\Services\Assistant\Providers\OpenAiProvider;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

class AssistantService
{
    public function __construct(
        protected ToolManager $toolManager,
        protected SecurityGuard $securityGuard
    ) {}

    /**
     * Resolve configured AI Provider.
     */
    public function resolveProvider(): AiProviderInterface
    {
        $provider = env('AI_PROVIDER', 'local');

        return match (strtolower($provider)) {
            'anthropic', 'claude', 'bedrock' => new AnthropicProvider(),
            'openai', 'groq', 'gemini'       => new OpenAiProvider(),
            default                          => new LocalHeuristicProvider(),
        };
    }

    /**
     * Process staff question end-to-end.
     */
    public function handle(string $message, User $user, ?string $conversationId = null): array
    {
        $startTime = microtime(true);
        $conversationId = $conversationId ?: (string) Str::uuid();

        // 1. Prompt Injection & Security Guard Check
        $sanitizedMessage = $this->securityGuard->sanitize($message);
        if ($warning = $this->securityGuard->detectInjection($sanitizedMessage)) {
            $durationMs = (int) round((microtime(true) - $startTime) * 1000);
            $this->logInteraction($user, $conversationId, $message, [], $warning, 15, $durationMs, 'security_guard');

            return [
                'conversation_id' => $conversationId,
                'role' => $user->role,
                'user_name' => $user->name,
                'reply' => $warning,
                'tools_called' => [],
                'tokens_used' => 15,
                'response_time_ms' => $durationMs,
            ];
        }

        // 2. Load Conversation Context & History
        $context = ConversationContext::for($conversationId);
        $history = $context->getHistory();
        $tools = $this->toolManager->getToolDefinitions();

        // 3. Resolve AI provider
        $provider = $this->resolveProvider();
        $toolsExecuted = [];
        $totalTokens = 0;
        $finalReply = '';

        try {
            $decision = $provider->generateResponse($sanitizedMessage, $history, $tools, $user);

            if (($decision['type'] ?? '') === 'tool_call') {
                $toolName = $decision['tool'];
                $params = $decision['parameters'] ?? [];

                // Execute tool with strict in-tool role permissions
                $toolResult = $this->toolManager->execute($toolName, $params, $user, $context);
                $toolsExecuted[] = [
                    'tool' => $toolName,
                    'input' => $params,
                    'output' => $toolResult,
                ];

                // Synthesize final natural language answer
                $synth = $provider->synthesizeAnswer($sanitizedMessage, $history, [$toolResult], $user);
                $finalReply = $synth['text'] ?? '';
                $totalTokens += ($synth['tokens'] ?? 50);
            } else {
                $finalReply = $decision['text'] ?? 'Unable to process your request.';
                $totalTokens += 30;
            }
        } catch (\Throwable $e) {
            Log::error("Assistant processing error: {$e->getMessage()}", ['exception' => $e]);
            $finalReply = "I encountered an error connecting to ERP services: " . $e->getMessage();
        }

        $durationMs = (int) round((microtime(true) - $startTime) * 1000);

        // 4. Update Conversation Context
        $context->addTurn($message, $finalReply, $toolsExecuted);

        // 5. Audit Logging to assistant_logs table
        $this->logInteraction(
            $user,
            $conversationId,
            $message,
            $toolsExecuted,
            $finalReply,
            $totalTokens,
            $durationMs,
            $provider->getProviderName()
        );

        return [
            'conversation_id' => $conversationId,
            'role' => $user->role,
            'user_name' => $user->name,
            'reply' => $finalReply,
            'tools_called' => $toolsExecuted,
            'tokens_used' => $totalTokens,
            'response_time_ms' => $durationMs,
            'provider' => $provider->getProviderName(),
            'pending_draft' => $context->getPendingDraftToken(),
        ];
    }

    protected function logInteraction(
        User $user,
        string $conversationId,
        string $question,
        array $toolsCalled,
        string $finalAnswer,
        int $tokens,
        int $durationMs,
        string $provider
    ): void {
        AssistantLog::create([
            'user_id' => $user->id,
            'conversation_id' => $conversationId,
            'question' => $question,
            'tools_called' => $toolsCalled,
            'final_answer' => $finalAnswer,
            'tokens_used' => $tokens,
            'response_time_ms' => $durationMs,
            'provider' => $provider,
        ]);
    }
}
