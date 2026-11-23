<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\AssistantChatRequest;
use App\Models\AssistantLog;
use App\Services\Assistant\AssistantService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class AssistantController extends Controller
{
    public function __construct(
        protected AssistantService $assistantService
    ) {}

    /**
     * POST /api/assistant
     * Primary endpoint answering staff questions by invoking role-checked tools.
     */
    public function chat(AssistantChatRequest $request): JsonResponse
    {
        $user = $request->user();
        $message = $request->validated('message');
        $conversationId = $request->validated('conversation_id');

        $result = $this->assistantService->handle($message, $user, $conversationId);

        return response()->json($result);
    }

    /**
     * POST /api/ts-agent/chat
     * Forward chat directly to the separate TypeScript AI Agent microservice.
     */
    public function tsAgentChat(AssistantChatRequest $request): JsonResponse
    {
        $user = $request->user();
        $token = $request->bearerToken();
        $message = $request->validated('message');
        $conversationId = $request->validated('conversation_id');

        // Support container-to-container (http://ts-agent:3001) as well as host (http://localhost:3001)
        $configuredUrl = rtrim(env('TS_AGENT_URL', 'http://ts-agent:3001'), '/');
        $candidateUrls = array_values(array_unique([
            $configuredUrl,
            'http://ts-agent:3001',
            'http://localhost:3001',
            'http://127.0.0.1:3001',
        ]));

        $lastException = null;
        $response = null;

        foreach ($candidateUrls as $url) {
            try {
                $resp = \Illuminate\Support\Facades\Http::timeout(90)
                    ->withToken($token)
                    ->post("{$url}/chat", [
                        'message' => $message,
                        'conversation_id' => $conversationId,
                        'role' => $user->role,
                        'token' => $token,
                        'user' => [
                            'id' => $user->id,
                            'name' => $user->name,
                            'email' => $user->email,
                            'role' => $user->role,
                        ],
                    ]);

                if ($resp->successful() || $resp->status() < 500) {
                    $response = $resp;
                    break;
                }
            } catch (\Throwable $e) {
                $lastException = $e;
                continue;
            }
        }

        if ($response && $response->successful()) {
            $data = $response->json();

            // Record into assistant_logs table for audit trail
            try {
                AssistantLog::create([
                    'user_id' => $user->id,
                    'conversation_id' => $conversationId,
                    'question' => $message,
                    'tools_called' => $data['tools_called'] ?? [],
                    'final_answer' => $data['reply'] ?? '',
                    'tokens_used' => (int) ($data['tokens_used'] ?? 0),
                    'response_time_ms' => (int) ($data['response_time_ms'] ?? 0),
                    'provider' => 'Google Gemini (ts-agent:3001)',
                ]);
            } catch (\Throwable $e) {
                \Illuminate\Support\Facades\Log::warning('Failed to log assistant interaction: ' . $e->getMessage());
            }

            return response()->json($data);
        }

        if ($response) {
            return response()->json([
                'error' => 'TS Agent returned error status: ' . $response->status(),
                'details' => $response->body(),
            ], $response->status());
        }

        return response()->json([
            'error' => 'Unable to connect to AI Agent service at ' . $configuredUrl,
            'message' => $lastException?->getMessage() ?? 'Connection refused',
        ], 502);
    }

    /**
     * GET /api/assistant/logs
     * Audit trail of assistant conversations, tools used, token usage, latency.
     */
    public function logs(Request $request): JsonResponse
    {
        $user = $request->user();

        $query = AssistantLog::with('user:id,name,role')->latest();

        if ($request->filled('conversation_id')) {
            $query->where('conversation_id', $request->conversation_id);
        }

        $logs = $query->paginate(20);

        return response()->json($logs);
    }
}
