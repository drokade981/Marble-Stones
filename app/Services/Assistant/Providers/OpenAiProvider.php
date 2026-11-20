<?php

namespace App\Services\Assistant\Providers;

use App\Models\User;
use App\Services\Assistant\Contracts\AiProviderInterface;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

class OpenAiProvider implements AiProviderInterface
{
    public function __construct(
        protected ?string $apiKey = null,
        protected string $model = 'gpt-4o-mini',
        protected string $baseUrl = 'https://api.openai.com/v1'
    ) {
        $this->apiKey = $this->apiKey ?: config('services.ai.openai_key', env('OPENAI_API_KEY'));
        $this->model = config('services.ai.openai_model', env('OPENAI_MODEL', 'gpt-4o-mini'));
        $this->baseUrl = config('services.ai.openai_base_url', env('OPENAI_BASE_URL', 'https://api.openai.com/v1'));
    }

    public function getProviderName(): string
    {
        return 'openai';
    }

    public function generateResponse(string $message, array $history, array $tools, User $user): array
    {
        if (empty($this->apiKey)) {
            // Fall back cleanly if key is omitted
            $fallback = new LocalHeuristicProvider();
            return $fallback->generateResponse($message, $history, $tools, $user);
        }

        // Format tools for OpenAI function calling
        $formattedTools = [];
        foreach ($tools as $tool) {
            $formattedTools[] = [
                'type' => 'function',
                'function' => [
                    'name' => $tool['name'],
                    'description' => $tool['description'],
                    'parameters' => $tool['parameters'],
                ],
            ];
        }

        $systemPrompt = "You are the ERP Assistant for a stone and quartz distributor. " .
            "The logged-in user is {$user->name} with role: '{$user->role}'. " .
            "Always call tools to retrieve data. Never make up numbers. Never write SQL. " .
            "If user role is 'sales', they cannot view landed costs or freight. " .
            "For creating purchase orders, always show the draft first and require user confirmation.";

        $messages = [
            ['role' => 'system', 'content' => $systemPrompt],
        ];

        foreach ($history as $h) {
            $messages[] = ['role' => 'user', 'content' => $h['user']];
            $messages[] = ['role' => 'assistant', 'content' => $h['assistant']];
        }

        $messages[] = ['role' => 'user', 'content' => $message];

        try {
            $response = Http::timeout(15)
                ->withToken($this->apiKey)
                ->post("{$this->baseUrl}/chat/completions", [
                    'model' => $this->model,
                    'messages' => $messages,
                    'tools' => $formattedTools,
                    'tool_choice' => 'auto',
                ]);

            if ($response->failed()) {
                Log::error('OpenAI API Error: ' . $response->body());
                $fallback = new LocalHeuristicProvider();
                return $fallback->generateResponse($message, $history, $tools, $user);
            }

            $data = $response->json();
            $choice = $data['choices'][0]['message'] ?? [];

            if (!empty($choice['tool_calls'])) {
                $toolCall = $choice['tool_calls'][0]['function'];
                $args = json_decode($toolCall['arguments'], true) ?: [];

                return [
                    'type' => 'tool_call',
                    'tool' => $toolCall['name'],
                    'parameters' => $args,
                ];
            }

            return [
                'type' => 'direct_response',
                'text' => $choice['content'] ?? 'I could not process your query.',
            ];
        } catch (\Throwable $e) {
            Log::error('OpenAI Exception: ' . $e->getMessage());
            $fallback = new LocalHeuristicProvider();
            return $fallback->generateResponse($message, $history, $tools, $user);
        }
    }

    public function synthesizeAnswer(string $message, array $history, array $toolResults, User $user): array
    {
        if (empty($this->apiKey)) {
            $fallback = new LocalHeuristicProvider();
            return $fallback->synthesizeAnswer($message, $history, $toolResults, $user);
        }

        // We can do a second LLM turn or use local synthesis
        $fallback = new LocalHeuristicProvider();
        return $fallback->synthesizeAnswer($message, $history, $toolResults, $user);
    }
}
