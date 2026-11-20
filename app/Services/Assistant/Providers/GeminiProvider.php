<?php

namespace App\Services\Assistant\Providers;

use App\Models\User;
use App\Services\Assistant\Contracts\AiProviderInterface;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

class GeminiProvider implements AiProviderInterface
{
    public function __construct(
        protected ?string $apiKey = null,
        protected string $model = 'gemini-1.5-flash',
        protected string $baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai'
    ) {
        $this->apiKey = $this->apiKey ?: config('services.ai.gemini_key', env('GEMINI_API_KEY'));
        $this->model = config('services.ai.gemini_model', env('GEMINI_MODEL', 'gemini-1.5-flash'));
        $this->baseUrl = config('services.ai.gemini_base_url', env('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta/openai'));
    }

    public function getProviderName(): string
    {
        return 'gemini';
    }

    public function generateResponse(string $message, array $history, array $tools, User $user): array
    {
        if (empty($this->apiKey)) {
            // Smoothly fallback to local heuristic engine if API key is not yet set
            $fallback = new LocalHeuristicProvider();
            return $fallback->generateResponse($message, $history, $tools, $user);
        }

        // Format tools for Gemini function calling
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

        $systemPrompt = "You are the AI Assistant for a US stone and quartz distributor ERP. " .
            "The logged-in staff member is {$user->name} with role '{$user->role}'. " .
            "Always call tools to read live ERP inventory, purchase orders, and landed costs. " .
            "Never invent numbers. If data is missing, state it clearly. Never write or run SQL. " .
            "If the user role is 'sales', they are forbidden from viewing landed costs or freight. " .
            "For draft purchase orders, present the draft and require the user to reply 'confirm' before persisting.";

        $messages = [
            ['role' => 'system', 'content' => $systemPrompt],
        ];

        foreach ($history as $h) {
            $messages[] = ['role' => 'user', 'content' => $h['user']];
            $messages[] = ['role' => 'assistant', 'content' => $h['assistant']];
        }

        $messages[] = ['role' => 'user', 'content' => $message];

        try {
            $response = Http::timeout(20)
                ->withHeaders([
                    'Authorization' => "Bearer {$this->apiKey}",
                    'Content-Type' => 'application/json',
                ])
                ->post("{$this->baseUrl}/chat/completions", [
                    'model' => $this->model,
                    'messages' => $messages,
                    'tools' => $formattedTools,
                    'tool_choice' => 'auto',
                ]);

            if ($response->failed()) {
                Log::error('Gemini API Error: ' . $response->body());
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
                'text' => $choice['content'] ?? 'Unable to process query.',
            ];
        } catch (\Throwable $e) {
            Log::error('Gemini Exception: ' . $e->getMessage());
            $fallback = new LocalHeuristicProvider();
            return $fallback->generateResponse($message, $history, $tools, $user);
        }
    }

    public function synthesizeAnswer(string $message, array $history, array $toolResults, User $user): array
    {
        $fallback = new LocalHeuristicProvider();
        return $fallback->synthesizeAnswer($message, $history, $toolResults, $user);
    }
}
