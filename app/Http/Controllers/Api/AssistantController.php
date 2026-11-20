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

        $agentUrl = env('TS_AGENT_URL', 'http://localhost:3001');

        try {
            $response = \Illuminate\Support\Facades\Http::timeout(15)
                ->withToken($token)
                ->post("{$agentUrl}/chat", [
                    'message' => $message,
                    'conversation_id' => $conversationId,
                    'role' => $user->role,
                ]);

            if ($response->successful()) {
                return response()->json($response->json());
            }

            return response()->json([
                'error' => 'TS Agent returned error status: ' . $response->status(),
                'details' => $response->body(),
            ], $response->status());
        } catch (\Throwable $e) {
            return response()->json([
                'error' => 'Unable to connect to TypeScript Agent service at ' . $agentUrl,
                'message' => $e->getMessage(),
            ], 502);
        }
    }

    /**
     * GET /api/assistant/logs
     * Audit trail of assistant conversations, tools used, token usage, latency.
     */
    public function logs(Request $request): JsonResponse
    {
        $user = $request->user();

        $query = AssistantLog::with('user:id,name,role')->latest();

        // If Sales, restrict logs to their own user
        if ($user->isSales()) {
            $query->where('user_id', $user->id);
        }

        if ($request->filled('conversation_id')) {
            $query->where('conversation_id', $request->conversation_id);
        }

        $logs = $query->paginate(20);

        return response()->json($logs);
    }
}
