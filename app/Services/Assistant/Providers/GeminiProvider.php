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
        protected string $model = 'gemini-3.5-flash-lite',
        protected string $baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai'
    ) {
        $this->apiKey = $this->apiKey ?: config('services.ai.gemini_key', env('GEMINI_API_KEY'));
        $this->model = config('services.ai.gemini_model', env('GEMINI_MODEL', 'gemini-3.5-flash-lite'));
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
            "DATABASE RELEVANCE & SCOPE: You ONLY answer questions relevant to our stone & quartz ERP database (products, slabs, stock across Houston/Dallas/Chicago warehouses, suppliers, purchase orders, landed costs). " .
            "If the user asks ANY question NOT relevant to the database (such as world capitals, geography like 'what is capital of india', history, trivia, coding, weather, math, entertainment, sports), YOU MUST DENY THE ANSWER in simple language. Reply strictly: 'I don't have proper data about it. I can only answer about inventory and purchasing.' " .
            "For greetings (hi, hello, etc.) or questions about your capabilities, respond politely and dynamically as the Stone & Quartz ERP AI Assistant. " .
            "Always call tools to read live ERP inventory, purchase orders, and landed costs. Never invent numbers. Never write or run SQL. " .
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

            $text = trim($choice['content'] ?? '');

            // Guardrail: if question is not relevant to stone ERP or greeting, ensure denied answer
            $lower = strtolower(trim($message));
            $isGreeting = preg_match('/^(hi|hello|hey|help|howdy|good\s+(morning|afternoon|evening))\b/i', $lower);
            $isStoneQuery = preg_match('/\b(slab|slabs|stone|quartz|marble|granite|quartzite|calacatta|carrara|marquina|statuario|thickness|2cm|3cm|inventory|stock|warehouse|houston|dallas|chicago|supplier|purchase\s+order|po[- ]?\d+|draft|delayed|late|freight|landed|cost)\b/i', $lower);

            if (!$isGreeting && !$isStoneQuery) {
                $text = "I don't have proper data about it. I can only answer about inventory and purchasing.";
            }

            return [
                'type' => 'direct_response',
                'text' => $text ?: "I don't have proper data about it. I can only answer about inventory and purchasing.",
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

