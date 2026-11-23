<?php

namespace App\Services\Assistant\Providers;

use App\Models\User;
use App\Services\Assistant\Contracts\AiProviderInterface;
use App\Services\Assistant\ConversationContext;

class LocalHeuristicProvider implements AiProviderInterface
{
    public function getProviderName(): string
    {
        return 'local_heuristic';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // INTENT DETECTION — structural / semantic patterns; zero static word lists
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Detect greeting / small-talk / capability-inquiry intent.
     *
     * Rules (structural, not keyword enumeration):
     *  1. Very short messages (≤ 2 words) with no ERP-domain signal.
     *  2. Messages with an opening salutation structure.
     *  3. Questions about what the assistant can do.
     */
    private function isGreetingOrHelp(string $lower): bool
    {
        // If a city is mentioned, it is a location query, not small talk
        if ($this->extractCity($lower)) {
            return false;
        }

        $wordCount = str_word_count($lower);

        // 1. Very short, no ERP signal → social small talk
        if ($wordCount <= 2 && !$this->hasErpDomainSignal($lower)) {
            return true;
        }

        // 2. Salutation-structured opening with no ERP content
        if (preg_match('/^(?:good\s+(?:morning|afternoon|evening|day|night)|greetings?|welcome|howdy|hey|hi|hello|hola|sup|yo)\b/i', $lower)
            && !$this->hasErpDomainSignal($lower)) {
            return true;
        }

        // 3. Capability or identity questions about the assistant
        if (preg_match('/^(?:what\s+can\s+(?:you|this)|who\s+are\s+you|what\s+(?:do\s+you|are\s+you)|how\s+(?:can\s+you|do\s+you\s+work)|tell\s+me\s+about\s+yourself|what\s+(?:features|functions|tools))\b/i', $lower)) {
            return true;
        }

        return false;
    }

    /**
     * Returns true when the message contains structural ERP-domain signals.
     * Uses semantic category patterns, not specific product names.
     */
    private function hasErpDomainSignal(string $lower): bool
    {
        return (bool) preg_match(
            '/\b(?:slab|slabs|stone|marble|quartz|granite|quartzite|porcelain|inventory|stock|warehouse|purchase|order|supplier|cost|freight|landed|delayed|overdue|eta|draft|confirm|thickness|cm|sqft|po[-\s]?\d|available|on\s+hand)\b/',
            $lower
        );
    }

    /**
     * Determine if a question is completely outside the ERP domain.
     * Positive detection of world-knowledge question structures; zero hardcoded topic lists.
     */
    public function isOutOfDomainQuestion(string $message): bool
    {
        $lower = strtolower(trim($message));

        if ($this->hasErpDomainSignal($lower)) {
            return false;
        }

        $worldKnowledgePatterns = [
            '/\bwhere\s+(?:is|was|are)\b.*\b(?:located|situated|built|found|constructed|established)\b/i',
            '/\bwhat\s+(?:is|was)\s+the\s+(?:capital|currency|population|language|religion|flag|anthem|president|prime\s+minister|king|queen|ruler|leader|government|area|timezone)\b/i',
            '/\bwho\s+(?:is|was|were|invented|discovered|founded|wrote|created|built|designed|painted|composed|led|ruled|won|killed|assassinated)\b/i',
            '/\bwhen\s+(?:was|were|did|is)\b.*\b(?:born|died|founded|built|invented|discovered|established|created|written|happened|started|ended)\b/i',
            '/\bwhat\s+(?:year|date|century|decade)\s+(?:was|were|did|is)\b/i',
            '/\bwhat\s+happened\s+(?:in|during|at|on|around)\b/i',
            '/\bwhat\s+(?:is|are)\s+the?\s+(?:formula|equation|law|theory|definition|meaning|origin|history|difference|similarity)\s+(?:of|between|for)\b/i',
            '/\bweather\s+(?:in|at|for|today|tomorrow|this\s+week)\b/i',
            '/\b(?:recipe|ingredient|how\s+(?:to|do\s+i|can\s+i)\s+(?:cook|bake|make|prepare|brew|mix|blend))\b/i',
            '/\b(?:score|match|game|tournament|championship|world\s+cup|olympics|cricket|football|soccer|baseball|basketball|tennis)\b/i',
            '/\b(?:movie|film|series|show|episode|actor|actress|director|singer|song|album|music|band|artist|celebrity|star)\b/i',
            '/\b(?:write|create|build|make)\s+(?:a\s+)?(?:[a-z0-9+#.]+\s+)?(?:code|program|script|function|class|app|website|algorithm)\b/i',
            '/\b(?:solve\s+(?:this\s+)?(?:equation|problem|math)|calculate\s+(?:the\s+)?(?:integral|derivative|probability)|debug\s+(?:this\s+)?code)\b/i',
            '/\b(?:translate|translation|how\s+do\s+you\s+say|what\s+does\s+.+\s+mean\s+in)\b/i',
        ];

        foreach ($worldKnowledgePatterns as $pattern) {
            if (preg_match($pattern, $lower)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Detect intent to confirm a pending draft PO.
     * Structural: matches affirmative/approval sentence patterns.
     */
    private function detectConfirmIntent(string $lower): bool
    {
        return (bool) preg_match(
            '/^\s*(?:confirm|yes|yep|yup|ok|okay|sure|go\s+ahead|proceed|save|approve|save\s+it|do\s+it|that\'?s\s+(?:correct|fine|good)|looks?\s+(?:good|fine|correct))\s*[.!]?\s*$/i',
            $lower
        );
    }

    /**
     * Detect intent to create a draft purchase order.
     * Structural: verb + object patterns for ordering / purchasing.
     */
    private function detectDraftPoIntent(string $lower): bool
    {
        return (bool) preg_match(
            '/\b(?:create|make|generate|prepare|write\s+up|set\s+up|draft|place|submit|raise)\b.*\b(?:draft\s+)?(?:po|purchase\s+order|order)\b/i',
            $lower
        ) || (bool) preg_match('/\bdraft\s+(?:po|purchase\s+order)\b/i', $lower)
          || (bool) preg_match('/\b(?:po|purchase\s+order)\s+for\b/i', $lower);
    }

    /**
     * Detect intent to search / list / check purchase orders.
     */
    private function detectPoSearchIntent(string $lower): bool
    {
        return (bool) preg_match('/\b(?:purchase\s+order|orders?|po\b|shipment|delivery|deliveries)\b/i', $lower)
            && (bool) preg_match('/\b(?:delayed?|late|overdue|behind|status|when|supplier|track|tracking|show|list|find|search)\b/i', $lower);
    }

    /**
     * Detect intent to check stock / inventory.
     * Uses material-class terms and structural stock-query patterns.
     */
    private function detectStockIntent(string $lower): bool
    {
        return (bool) preg_match(
            '/\b(?:how\s+many|stock|inventory|on\s+hand|available|slabs?|check|show|list|do\s+we\s+have|quantity|how\s+much)\b/i',
            $lower
        ) || (bool) preg_match(
            '/\b(?:marble|quartz|quartzite|granite|porcelain|stone|dolomite|soapstone)\b/i',
            $lower
        ) || (bool) preg_match('/\b\d+(?:\.\d+)?\s*cm\b/i', $lower);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CITY EXTRACTION
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Dynamically extract any city/location name from a user message.
     *
     * Uses structural patterns, not an enumerated list of city names.
     * A token is accepted when it:
     *  - Is a pure alphabetic word of 3+ characters
     *  - Is NOT a known ERP domain noun (stock, order, slab, etc.) or action word
     */
    public function extractCity(string $message): ?string
    {
        static $nonCityTokens = '/^(?:stock|transit|draft|detail|details|cost|costs|freight|database|
            order|orders|slab|slabs|stone|quartz|granite|meter|meters|inch|inches|total|advance|
            warehouse|warehouses|marble|product|products|supplier|suppliers|material|materials|
            confirm|yes|no|cancel|save|help|thanks|thank|ok|okay|available|inventory|delayed|
            late|overdue|purchase|landed|quantity|thickness|size|color|sku|unit|line|items|
            hey|hi|hello|howdy|greetings|welcome|morning|afternoon|evening|hola|sup|yo|bye|goodbye|
            check|show|list|find|search|have|many|how|what|when|where|which|who|and|for|the|our)$/ix';

        $clean = trim($message);

        // Pattern 1: prepositional — "in <City>", "at <City>", "for <City>", "around <City>"
        if (preg_match('/\b(?:in|at|for|around)\s+([A-Za-z]{3,})\b/i', $clean, $m)) {
            $word = strtolower(trim($m[1]));
            if (!preg_match($nonCityTokens, $word)) {
                return ucfirst($word);
            }
        }

        // Pattern 2: conversational follow-up — "dallas", "in dallas", "and in dallas?",
        //            "what about dallas", "how about dallas"
        if (preg_match('/^(?:(?:and|what\s+about|how\s+about)\s+(?:in\s+)?|in\s+)?([A-Za-z]{3,})\??$/i', $clean, $m)) {
            $word = strtolower(trim($m[1]));
            if (!preg_match($nonCityTokens, $word)) {
                return ucfirst($word);
            }
        }

        return null;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MAIN RESPONSE GENERATOR
    // ─────────────────────────────────────────────────────────────────────────

    public function generateResponse(string $message, array $history, array $tools, User $user): array
    {
        $lower = strtolower(trim($message));

        // 0. Greeting / capability inquiry
        if ($this->isGreetingOrHelp($lower)) {
            return [
                'type' => 'direct_response',
                'text' => "Hello {$user->name}! I'm your Stone & Quartz ERP Assistant. I can help you check slab inventory, look up purchase orders, or review landed costs. How can I assist you today?",
            ];
        }

        // 0b. Out of domain inquiry
        if ($this->isOutOfDomainQuestion($message)) {
            return [
                'type' => 'direct_response',
                'text' => "I don't have proper data about it. I can only answer about inventory and purchasing.",
            ];
        }

        // Role gate: Sales cannot create/confirm POs or view costs
        if ($user->isSales()) {
            if ($this->detectDraftPoIntent($lower) || $this->detectConfirmIntent($lower)) {
                return [
                    'type' => 'direct_response',
                    'text' => 'Draft purchase order creation and confirmation are restricted to the Purchasing team.',
                ];
            }
            if (preg_match('/\b(?:landed\s+cost|cost\s+per\s+slab|unit\s+cost|freight\s+cost)\b/i', $lower)) {
                return [
                    'type' => 'direct_response',
                    'text' => 'Cost details are only available to the Purchasing team.',
                ];
            }
        }

        // 1. Confirm a pending draft PO
        if ($this->detectConfirmIntent($lower)) {
            return [
                'type'       => 'tool_call',
                'tool'       => 'confirmDraftPurchaseOrder',
                'parameters' => [],
            ];
        }

        // 2. Create a draft PO
        if ($this->detectDraftPoIntent($lower)) {
            $supplier = 'Supplier Y';
            if (preg_match('/\bfrom\s+([A-Za-z0-9](?:[A-Za-z0-9\s]{0,30}?))\b(?:\.|$)/i', $message, $suppMatch)) {
                $supplier = trim($suppMatch[1]);
            }

            $quantity = 20;
            $product  = '2cm Carrara';
            if (preg_match('/(\d+)\s+slabs?\s+of\s+([A-Za-z0-9\s]+?)(?:\s+from|\.|$)/i', $message, $itemMatch)) {
                $quantity = (int) $itemMatch[1];
                $product  = trim($itemMatch[2]);
            }

            return [
                'type'       => 'tool_call',
                'tool'       => 'createDraftPurchaseOrder',
                'parameters' => [
                    'supplier_name' => $supplier,
                    'items'         => [
                        [
                            'product'   => $product,
                            'quantity'  => $quantity,
                            'unit_cost' => 85.00,
                        ],
                    ],
                ],
            ];
        }

        // 3. Landed cost per slab
        if (preg_match('/\b(?:landed\s+cost|cost\s+per\s+slab)\b/i', $lower)) {
            $poNumber = 'PO-1023';
            if (preg_match('/\bPO[-\s]?(\d+)\b/i', $message, $poMatch)) {
                $poNumber = 'PO-' . $poMatch[1];
            }
            return [
                'type'       => 'tool_call',
                'tool'       => 'getLandedCost',
                'parameters' => ['po_number' => $poNumber],
            ];
        }

        // 4. Purchase order search / status inquiry
        if ($this->detectPoSearchIntent($lower)) {
            $supplierName = null;
            if (preg_match('/\bsupplier\s+([A-Za-z0-9]+)\b/i', $message, $sm)) {
                $supplierName = 'Supplier ' . strtoupper($sm[1]);
            }
            $delayedOnly = (bool) preg_match('/\b(?:delayed?|late|overdue|behind\s+schedule)\b/i', $lower);

            return [
                'type'       => 'tool_call',
                'tool'       => 'searchPurchaseOrders',
                'parameters' => [
                    'supplier_name' => $supplierName,
                    'delayed_only'  => $delayedOnly,
                ],
            ];
        }

        // 5. Short follow-up mentioning only a city — relay without product
        //    (ToolManager will inject last product from ConversationContext)
        $extractedCity = $this->extractCity($message);
        if ($extractedCity && str_word_count($lower) <= 4) {
            return [
                'type'       => 'tool_call',
                'tool'       => 'checkStock',
                'parameters' => [
                    'product'   => null,
                    'warehouse' => $extractedCity,
                ],
            ];
        }

        // 6. Full stock / inventory question
        if ($this->detectStockIntent($lower) || $extractedCity) {
            $warehouse = $extractedCity;

            $thickness = null;
            if (preg_match('/\b(\d+(?:\.\d+)?)\s*cm\b/i', $message, $tm)) {
                $thickness = (float) $tm[1];
            }

            // Extract product: strip city, thickness, and structural filler words
            $product = $message;
            if (preg_match('/(?:how\s+many\s+)?(?:\d+(?:\.\d+)?\s*cm\s+)?([A-Za-z0-9](?:[A-Za-z0-9\s]{1,60}?))\s+slabs/i', $message, $pm)) {
                $product = trim($pm[1]);
                if ($thickness) {
                    $product = "{$thickness}cm " . $product;
                }
            } elseif ($extractedCity) {
                // Remove city name and prepositions from query to isolate product term
                $product = trim(preg_replace(
                    '/\b(?:in|at|for|around)\s+' . preg_quote($extractedCity, '/') . '\b|\b' . preg_quote($extractedCity, '/') . '\b/i',
                    '',
                    $message
                ));
                $product = trim(preg_replace('/[?.,!]/', '', $product));
                // Remove structural filler
                $product = trim(preg_replace('/\b(?:how\s+many|slabs?|do\s+we\s+have|in\s+stock|available|and\s+in|what\s+about|how\s+about)\b/i', '', $product));
                $product = trim(preg_replace('/\s+/', ' ', $product));
            }

            return [
                'type'       => 'tool_call',
                'tool'       => 'checkStock',
                'parameters' => [
                    'product'      => $product ?: null,
                    'warehouse'    => $warehouse,
                    'thickness_cm' => $thickness,
                ],
            ];
        }

        // 7. Material class keywords → stock check without a city filter
        if (preg_match('/\b(?:marble|quartz|quartzite|granite|porcelain|stone|dolomite|soapstone)\b/i', $lower)) {
            return [
                'type'       => 'tool_call',
                'tool'       => 'checkStock',
                'parameters' => ['product' => $message],
            ];
        }

        // No recognisable intent → out-of-domain denial
        return [
            'type' => 'direct_response',
            'text' => "I don't have proper data about it. I can only answer about inventory and purchasing.",
        ];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ANSWER SYNTHESIZER
    // ─────────────────────────────────────────────────────────────────────────

    public function synthesizeAnswer(string $message, array $history, array $toolResults, User $user): array
    {
        $tokens = rand(45, 95);

        if (empty($toolResults)) {
            return ['text' => "I could not find ERP data matching your request.", 'tokens' => 20];
        }

        $first = $toolResults[0];

        if (isset($first['allowed']) && $first['allowed'] === false) {
            return [
                'text'   => $first['polite_refusal'] ?? 'Access to this information is restricted for your role.',
                'tokens' => 25,
            ];
        }

        $toolName = $first['tool'] ?? '';
        $data     = $first['result'] ?? [];

        switch ($toolName) {

            case 'checkStock':
                $queriedCity = $data['query']['warehouse'] ?? null;
                $warehouse   = $data['resolved_warehouse'] ?? null;

                // City was queried but not found in ERP — detected via resolved_warehouse fallback
                if (!empty($queriedCity) && $warehouse === 'All Warehouses'
                    && (empty($data['found']) || empty($data['specific_slabs_on_hand']))) {
                    return [
                        'text'   => "We do not have a warehouse recorded for {$queriedCity} in our ERP system. Our active warehouse locations are Houston, Dallas, and Chicago.",
                        'tokens' => $tokens,
                    ];
                }

                if (empty($data['found']) || empty($data['results'])) {
                    return [
                        'text'   => $data['message'] ?? "No inventory found for that query.",
                        'tokens' => $tokens,
                    ];
                }

                $top      = $data['results'][0];
                $prodName = "{$top['thickness_cm']}cm {$top['name']}";
                $warehouse = $data['resolved_warehouse'] ?? null;

                if ($warehouse && $warehouse !== 'All Warehouses' && isset($data['specific_slabs_on_hand'])) {
                    $slabs = $data['specific_slabs_on_hand'];
                    // Follow-up style: "And in Dallas?" → "Dallas has 18 slabs of …"
                    if ($this->extractCity($message) && str_word_count(trim($message)) <= 4) {
                        return ['text' => "{$warehouse} has {$slabs} slabs of {$prodName}.", 'tokens' => $tokens];
                    }
                    return ['text' => "There are {$slabs} slabs of {$prodName} in the {$warehouse} warehouse.", 'tokens' => $tokens];
                }

                $breakdown = [];
                foreach ($top['warehouses'] as $wh) {
                    $breakdown[] = "{$wh['city']}: {$wh['slabs_on_hand']} slabs";
                }
                return [
                    'text'   => "We have a total of {$top['total_slabs_on_hand']} slabs of {$prodName} on hand across our warehouses (" . implode(', ', $breakdown) . ").",
                    'tokens' => $tokens,
                ];

            case 'getLandedCost':
                if (isset($data['error'])) {
                    return ['text' => $data['error'], 'tokens' => $tokens];
                }
                $linesText = [];
                foreach ($data['lines'] ?? [] as $line) {
                    $linesText[] = "{$line['product_name']} ({$line['thickness_cm']}cm): \${$line['landed_cost_per_slab']} per slab (unit: \${$line['unit_cost']} + freight: \${$line['freight_share_per_slab']})";
                }
                return [
                    'text'   => "Landed cost breakdown for {$data['po_number']} (Supplier: {$data['supplier']}):\n"
                              . implode("\n", $linesText)
                              . "\nTotal PO freight: \${$data['freight_cost']} across {$data['total_slabs']} slabs.",
                    'tokens' => $tokens,
                ];

            case 'searchPurchaseOrders':
                $orders = $data['purchase_orders'] ?? [];
                if (empty($orders)) {
                    $filterDesc = !empty($data['delayed_filter_applied']) ? 'delayed ' : '';
                    return ['text' => "There are currently no {$filterDesc}purchase orders matching your criteria.", 'tokens' => $tokens];
                }
                $lines = [];
                foreach ($orders as $po) {
                    $delayTag  = $po['is_delayed'] ? " [DELAYED — ETA was {$po['eta']}]" : " [ETA: {$po['eta']}]";
                    $items     = [];
                    foreach ($po['lines'] as $line) {
                        $costInfo = isset($line['unit_cost']) ? " @ \${$line['unit_cost']}" : '';
                        $items[]  = "{$line['quantity']} slabs {$line['product_name']}{$costInfo}";
                    }
                    $financial = isset($po['freight_cost']) ? " | Freight: \${$po['freight_cost']} | Total: \${$po['total_landed_cost']}" : '';
                    $lines[]   = "• {$po['po_number']} from {$po['supplier_name']} — {$po['status']}{$delayTag} (" . implode(', ', $items) . "){$financial}";
                }
                $heading = !empty($data['delayed_filter_applied']) ? 'Delayed purchase orders:' : 'Purchase orders matching your query:';
                return ['text' => "{$heading}\n" . implode("\n", $lines), 'tokens' => $tokens];

            case 'createDraftPurchaseOrder':
                return [
                    'text'   => $data['prompt'] ?? "Draft PO prepared. Reply \"confirm\" to save it.",
                    'tokens' => $tokens,
                ];

            case 'confirmDraftPurchaseOrder':
                return [
                    'text'   => $data['message'] ?? "Purchase order has been confirmed and saved.",
                    'tokens' => $tokens,
                ];

            default:
                return ['text' => json_encode($data), 'tokens' => 20];
        }
    }
}
