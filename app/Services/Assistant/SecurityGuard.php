<?php

namespace App\Services\Assistant;

class SecurityGuard
{
    protected array $injectionPatterns = [
        '/\b(ignore|disregard|forget|override)\s+(all\s+)?(previous|prior|above|system)\s+(instructions|rules|prompts|commands)\b/i',
        '/\b(you\s+are\s+now|act\s+as|pretend\s+to\s+be)\s+(an?\s+)?(admin|administrator|root|superuser|purchasing|unrestricted)\b/i',
        '/\b(system\s+override|developer\s+mode|jailbreak|dan\s+mode)\b/i',
        '/\b(union\s+select|select\s+.*\s+from|insert\s+into|drop\s+table|delete\s+from)\b/i',
        '/\b(reveal|show|print|leak)\s+(the\s+)?(system\s+prompt|hidden\s+instructions|api\s+keys?|passwords?)\b/i',
    ];

    /**
     * Check if user message contains prompt injection or adversarial jailbreak attempts.
     */
    public function detectInjection(string $message): ?string
    {
        foreach ($this->injectionPatterns as $pattern) {
            if (preg_match($pattern, $message)) {
                return 'Adversarial instruction or system override attempt detected. The AI ERP assistant only answers inventory and purchasing questions under verified role permissions.';
            }
        }

        return null;
    }

    /**
     * Sanitize user input text to prevent markdown injection or control character abuses.
     */
    public function sanitize(string $message): string
    {
        $clean = strip_tags($message);
        return trim($clean);
    }
}

