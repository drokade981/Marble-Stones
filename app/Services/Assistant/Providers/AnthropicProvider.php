<?php

namespace App\Services\Assistant\Providers;

use App\Models\User;
use App\Services\Assistant\Contracts\AiProviderInterface;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

class AnthropicProvider implements AiProviderInterface
{
    public function __construct(
        protected ?string $apiKey = null,
        protected string $model = 'claude-3-5-sonnet-20241022',
        protected string $baseUrl = 'https://api.anthropic.com/v1'
    ) {
        $this->apiKey = $this->apiKey ?: config('services.ai.anthropic_key', env('ANTHROPIC_API_KEY'));
        $this->model = config('services.ai.anthropic_model', env('ANTHROPIC_MODEL', 'claude-3-5-sonnet-20241022'));
    }

    public function getProviderName(): string
    {
        return 'anthropic';
    }

    public function generateResponse(string $message, array $history, array $tools, User $user): array
    {
        if (empty($this->apiKey)) {
            $fallback = new LocalHeuristicProvider();
            return $fallback->generateResponse($message, $history, $tools, $user);
        }

        // Format tools for Anthropic tool use
        $anthropicTools = [];
        foreach ($tools as $tool) {
            $anthropicTools[] = [
                'name' => $tool['name'],
                'description' => $tool['description'],
                'input_schema' => $tool['parameters'],
            ];
        }

        $messages = [];
        foreach ($history as $h) {
            $messages[] = ['role' => 'user', 'content' => $h['user']];
            $messages[] = ['role' => 'assistant', 'content' => $h['assistant']];
        }
        $messages[] = ['role' => 'user', 'content' => $message];

        try {
            $response = Http::timeout(15)
                ->withHeaders([
                    'x-api-key' => $this->apiKey,
                    'anthropic-version' => '2023-06-01',
                    'content-type' => 'application/json',
                ])
                ->post("{$this->baseUrl}/messages", [
                    'model' => $this->model,
                    'max_tokens' => 1024,
                    'tools' => $anthropicTools,
                    'messages' => $messages,
                ]);

            if ($response->failed()) {
                Log::error('Anthropic API Error: ' . $response->body());
                $fallback = new LocalHeuristicProvider();
                return $fallback->generateResponse($message, $history, $tools, $user);
            }

            $data = $response->json();
            $content = $data['content'] ?? [];

            foreach ($content as $block) {
                if ($block['type'] === 'tool_use') {
                    return [
                        'type' => 'tool_call',
                        'tool' => $block['name'],
                        'parameters' => $block['input'] ?? [],
                    ];
                }
            }

            $text = $content[0]['text'] ?? 'Unable to process query.';
            return [
                'type' => 'direct_response',
                'text' => $text,
            ];
        } catch (\Throwable $e) {
            Log::error('Anthropic Exception: ' . $e->getMessage());
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
