e:\task3\
├── docker-compose.yml              # 1-command startup (app, db, redis, queue, ts-agent)
├── docker/
│   ├── Dockerfile                  # PHP 8.3 CLI + extensions + Composer
│   └── entrypoint.sh               # Auto-migration, key-generation & database seeder
├── app/
│   ├── Http/Controllers/Api/
│   │   ├── AssistantController.php # POST /api/assistant & POST /api/ts-agent/chat
│   │   ├── AuthController.php      # POST /api/login & GET /api/user
│   │   └── ToolController.php      # REST endpoints for ERP tools
│   ├── Http/Requests/              # Form Requests for input validation
│   ├── Models/                     # Product, Warehouse, Stock, Supplier, PurchaseOrder, etc.
│   └── Services/
│       ├── Assistant/              # AssistantService, ToolManager, ConversationContext, SecurityGuard
│       │   ├── Contracts/          # AiProviderInterface
│       │   └── Providers/          # Anthropic, Bedrock, OpenAI, LocalHeuristic
│       ├── LandedCostService.php   # Per-slab freight allocation & landed cost math
│       ├── PurchaseOrderService.php# PO queries, draft staging & confirmation
│       ├── StockService.php        # Slab on-hand lookup with thickness extraction
│       └── ProductService.php      # Search & SKU resolution
├── database/
│   ├── migrations/                 # 12 migrations (warehouses, products, stock, suppliers, etc.)
│   └── seeders/DatabaseSeeder.php  # 22 products, 3 warehouses, 5 suppliers, 15 POs, 2 users
├── resources/views/welcome.blade.php # Interactive web chat UI with role switching
├── routes/
│   ├── api.php                     # Sanctum-authenticated API routes
│   └── web.php                     # Web chat UI route
├── tests/Feature/
│   ├── AssistantTest.php           # Challenge conversational flow tests
│   ├── LandedCostTest.php          # Mathematical verification of landed cost
│   └── RolePermissionsTest.php     # Direct tool permission checks
├── ts-agent/                       # Standalone TypeScript Node.js AI Agent
│   ├── src/
│   │   ├── agent.ts                # Autonomous agent engine with context memory
│   │   ├── erpClient.ts            # Sanctum-authenticated API client for Laravel
│   │   ├── index.ts                # Express server on port 3001
│   │   └── tools.ts                # Tool definitions & execution
│   ├── Dockerfile                  # Node 20 alpine container
│   ├── package.json
│   └── tsconfig.json
├── README.md                       # Comprehensive documentation with cost analysis & video script
└── .env.example                    # All environment variables documented