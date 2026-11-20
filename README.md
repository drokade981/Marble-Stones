# SlabERP AI Assistant — Natural Stone & Quartz ERP

[![Laravel](https://img.shields.io/badge/Laravel-12.x-red.svg)](https://laravel.com)
[![PHP](https://img.shields.io/badge/PHP-8.3-blue.svg)](https://php.net)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-blue.svg)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-7-red.svg)](https://redis.io)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED.svg)](https://docker.com)

An enterprise AI assistant designed for a US-based stone and quartz distributor ERP. Staff can query live inventory, track purchase order delays, inspect per-slab landed costs with strict role-based permission checks, and create/confirm draft purchase orders via conversational flow.

---

## Table of Contents
1. [One-Command Quick Start](#1-one-command-quick-start)
2. [Test Users & Roles](#2-test-users--roles)
3. [Architecture & Question Flow](#3-architecture--question-flow)
4. [Landed Cost Freight Allocation Rationale](#4-landed-cost-freight-allocation-rationale)
5. [TypeScript AI Agent Microservice](#5-typescript-ai-agent-microservice)
6. [ERP Integration Guide](#6-erp-integration-guide)
7. [Estimated AI Costs (per 1,000 Questions)](#7-estimated-ai-costs-per-1000-questions)
8. [Security & Prompt Injection Protection](#8-security--prompt-injection-protection)
9. [What We Would Improve With More Time](#9-what-we-would-improve-with-more-time)
10. [Test Suite Verification](#10-test-suite-verification)
11. [5–10 Minute Video Walkthrough Outline](#11-510-minute-video-walkthrough-outline)

---

## 1. One-Command Quick Start

The entire stack is packaged with Docker Compose. A single command starts PostgreSQL 16, Redis 7, the Laravel 12 API/Web application, background queue worker, and the standalone TypeScript AI Agent.

### Run with Docker Compose:
```bash
docker-compose up --build
```
*(On first launch, the entrypoint script automatically waits for PostgreSQL, generates the application key, runs all migrations, and seeds the full realistic dataset).*

Once running:
- **Interactive ERP Assistant Web UI**: [http://localhost:8000](http://localhost:8000)
- **Laravel ERP REST API**: `http://localhost:8000/api`
- **TypeScript AI Agent API**: `http://localhost:3001`
- **PostgreSQL**: `localhost:5432` (db: `laravel_erp`, user: `postgres`, pass: `postgres`)
- **Redis**: `localhost:6379`

### Alternative: Running Locally without Docker
```bash
# 1. Install dependencies
composer install
cd ts-agent && npm install && npm run build && cd ..

# 2. Configure environment
cp .env.example .env
php artisan key:generate

# 3. Migrate and seed database
php artisan migrate --seed

# 4. Start servers
php artisan serve --port=8000
cd ts-agent && npm start
```

---

## 2. Test Users & Roles

The system seeds two standard accounts with distinct permissions:

| Role | Email | Password | Allowed Capabilities | Restricted Capabilities |
| :--- | :--- | :--- | :--- | :--- |
| **Sales** | `sales@example.com` | `password123` | • View slab stock & warehouse quantities<br>• View PO operational status, ETA, lines & quantities | **Cannot view**: Freight costs, unit costs, landed costs, or supplier bank details.<br>**Cannot**: Create or confirm POs. |
| **Purchasing** | `purchasing@example.com` | `password123` | • View all inventory & PO data<br>• View supplier bank details (decrypted)<br>• Calculate landed cost per slab<br>• Create draft POs & confirm them | None (Full Operational & Financial Access) |

### Sample Prompts Tested Against Both Roles:

#### 1. Check Stock (Both Roles Allowed)
> **Staff:** *"How many 3cm Calacatta slabs do we have in Houston?"*  
> **Assistant:** `"There are 42 slabs of 3cm Calacatta in the Houston warehouse."`  
> *(Source: `checkStock` tool output from database, not LLM memory)*

#### 2. Follow-Up Context Memory
> **Staff:** *"And in Dallas?"*  
> **Assistant:** `"Dallas has 18 slabs of 3cm Calacatta."`  
> *(Context manager retains product query `3cm Calacatta` and resolves warehouse to Dallas)*

#### 3. Landed Cost Query (Role Enforced)
> **Sales User:** *"What is the landed cost per slab on PO-1023?"*  
> **Assistant:** `"Cost details are only available to the Purchasing team."` *(Polite refusal)*  
>
> **Purchasing User:** *"What is the landed cost per slab on PO-1023?"*  
> **Assistant:**  
> `"Landed cost breakdown for PO-1023 (Supplier: Supplier Y):`  
> `• Calacatta Gold (3cm): $150.00 per slab (unit cost: $120.00 + freight share: $30.00)`  
> `• Carrara White (2cm): $115.00 per slab (unit cost: $85.00 + freight share: $30.00)`  
> `Total PO Freight: $1,500.00 across 50 slabs (freight split: Per-slab quantity basis)."`

#### 4. Confirm-Before-Write PO Creation (Purchasing Only)
> **Purchasing User:** *"Create a draft PO for 20 slabs of 2cm Carrara from Supplier Y."*  
> **Assistant:** `"Here's the draft: 20 slabs of 2cm Carrara White from Supplier Y. Reply \"confirm\" to save it."`  
> *(Notice: Not written to database yet; stored in pending state).*  
>
> **Purchasing User:** *"confirm"*  
> **Assistant:** `"Purchase Order PO-1016 has been successfully created and saved for 20 slabs of 2cm Carrara White from Supplier Y."`

#### 5. Delayed Purchase Orders
> **Staff:** *"Which purchase orders from Supplier X are delayed?"*  
> **Assistant:** Lists PO-1010 and PO-1012 with their ETA dates past due and delayed status flags.

---

## 3. Architecture & Question Flow

```mermaid
flowchart TD
    User["Staff User (Browser Web UI / API)"] --> Auth["Laravel Sanctum Authentication"]
    Auth --> Request["POST /api/assistant"]
    Request --> Guard["SecurityGuard (Prompt Injection Defense)"]
    Guard --> Conv["ConversationContext (Loads History & Entities)"]
    Conv --> Agent["AI Decision Engine (Claude / Bedrock / OpenAI / Local)"]
    Agent --> ToolCall["Agent Picks Tool: checkStock / getLandedCost / createDraftPO"]
    ToolCall --> RoleCheck{"In-Tool Role Check<br>(User == Purchasing?)"}
    RoleCheck -- "No (Sales requesting costs)" --> Refusal["Polite Refusal Response<br>'Cost details are only available to Purchasing'"]
    RoleCheck -- "Yes" --> Service["ERP Service Layer<br>(StockService / LandedCostService / PurchaseOrderService)"]
    Service --> DB[("Database (PostgreSQL / MySQL)")]
    DB --> ToolResult["Tool Result Data (Numbers & Records)"]
    ToolResult --> Synthesis["Synthesize Answer (Strictly Grounded in Tool Data)"]
    Synthesis --> Logger["Audit Logger (assistant_logs)"]
    Refusal --> Logger
    Logger --> Response["JSON Response to User"]
```

### Key Principles:
1. **Tool Calling Only, Never Raw SQL**: The AI engine never generates or executes SQL. It interacts exclusively with structured, strongly typed Laravel service tools (`checkStock`, `searchPurchaseOrders`, `getLandedCost`, `createDraftPurchaseOrder`, `confirmDraftPurchaseOrder`).
2. **Permissions Inside Tools**: Security is not left to the LLM system prompt. Every tool verifies `$user->isPurchasing()` or `$user->isSales()` directly in PHP.
3. **Confirm Before Writing**: Draft purchase orders are staged in `draft_purchase_orders` with a unique token. The database `purchase_orders` record is created only after explicit user confirmation ("confirm").
4. **Contextual Memory**: `ConversationContext` caches the conversation state (subject product, warehouse, active PO, pending draft) for 2 hours in Redis.
5. **Audit Logging**: Every interaction records user ID, conversation ID, question, tools executed with inputs/outputs, final answer, tokens used, and response latency in milliseconds.

---

## 4. Landed Cost Freight Allocation Rationale

### Formula:
$$\text{Landed Cost per Slab} = \text{Line Unit Cost} + \left( \frac{\text{Total PO Freight Cost}}{\text{Total Slabs in PO}} \right)$$

### Why Quantity-Based (Per-Slab) Allocation?
In natural stone and engineered quartz distribution:
1. **Physical Shipping Constraints**: Slabs are heavy industrial freight (typically 400–900 lbs per slab). Shipping lines and flatbed logistics charge based on 20ft container weight capacity (~40,000–44,000 lbs max) and A-frame rack slot availability, not the retail or invoice value of the stone.
2. **Value Distortion Avoidance**: If freight were split by monetary value, an exotic \$350/slab Taj Mahal Quartzite would bear 4x more freight cost than an adjacent \$85/slab Carrara marble slab sharing the exact same container rack and burning the exact same transportation diesel.
3. **Industry Standard**: Slabs consume identical crane handling, crate packaging, and flatbed transport footprint regardless of colour or pattern. Dividing total freight evenly across all physical slabs accurately assigns logistics burden.

---

## 5. TypeScript AI Agent Microservice

Per the challenge requirements, a dedicated TypeScript + Node.js agent lives in `ts-agent/`:

- **Path**: `ts-agent/`
- **Port**: `3001` (`http://localhost:3001`)
- **Docker Container**: `slaberp-ts-agent`
- **Features**:
  - Connects to Laravel ERP API using Sanctum Bearer tokens.
  - Exposes `POST /chat` with natural language processing and session memory.
  - Exposes `GET /health` and `GET /tools`.
  - Automatically forwards user token to Laravel tool endpoints so Laravel validates identity and role checks.
  - Can be toggled live in the Web UI via the top header badge ("Laravel AI Agent" vs "TS/Node Agent").

---

## 6. ERP Integration Guide

To plug this assistant into an existing enterprise Laravel ERP:

1. **Mount Service Providers & Tools**:
   Copy `app/Services/Assistant/` and `app/Services/LandedCostService.php` into the existing ERP codebase.
2. **Register Sanctum Routes**:
   Include the `api/assistant` and `api/tools/*` route group in `routes/api.php`.
3. **Map Existing Models**:
   Point `Product`, `Warehouse`, `Stock`, `Supplier`, and `PurchaseOrder` to your existing ERP tables using Eloquent `$table` and foreign key definitions.
4. **Role Middleware Integration**:
   Map the assistant's `$user->isPurchasing()` and `$user->isSales()` methods to your ERP's existing permission system (e.g. Spatie Laravel-Permission: `$user->hasRole('purchasing')`).
5. **Front-End Widget**:
   Embed the Blade chat component into your ERP navigation bar or sidebar for immediate access across ERP screens.

---

## 7. Estimated AI Costs (per 1,000 Questions)

### Assumptions:
- Average prompt: 150 input tokens (system instructions + conversation history + user query + tool schemas).
- Average tool execution: 200 input tokens (ERP JSON tool output fed back to LLM).
- Average answer: 80 output tokens.
- Total per question: **350 input tokens** + **80 output tokens**.
- For 1,000 questions: **350,000 input tokens** and **80,000 output tokens**.

### Cost Comparison by Model:

| Provider / Model | Input Cost / 1M | Output Cost / 1M | Cost per 1,000 Questions | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **Claude 3.5 Haiku (Bedrock/Anthropic)** | \$0.80 | \$4.00 | **\$0.60** | **Recommended for production**: Ultra-fast, highly accurate tool calling. |
| **Claude 3.5 Sonnet (Bedrock/Anthropic)** | \$3.00 | \$15.00 | **\$2.25** | Best for complex multi-step purchasing logic. |
| **GPT-4o-mini (OpenAI)** | \$0.15 | \$0.60 | **\$0.10** | Lowest cost commercial model. |
| **Built-in Local Heuristic Provider** | \$0.00 | \$0.00 | **\$0.00** | Zero API keys required; 100% free offline execution. |

---

## 8. Security & Prompt Injection Protection

The assistant implements defense-in-depth:
1. **Deterministic Role Checks in Code**: Permissions are hard-coded in PHP service methods (`$user->isSales()`). The LLM prompt cannot bypass them because tools reject unauthorized calls before reading sensitive data.
2. **SecurityGuard Regex Filter**: Intercepts jailbreak attempts (`"ignore all previous rules"`, `"act as admin"`, `"union select"`, `"reveal system prompt"`) and returns an immediate safe refusal without invoking LLM tokens.
3. **Sanitized ERP Output**: Encrypted database attributes (like supplier bank details) are never loaded into arrays sent to the Sales user.
4. **Prepared Queries & Eloquent**: Parameterized query bindings prevent SQL injection.

---

## 9. What We Would Improve With More Time

1. **Streaming Responses (SSE)**: Implement Server-Sent Events (`text/event-stream`) in `POST /api/assistant` for real-time word-by-word token streaming in the chat UI.
2. **Asynchronous Queue Jobs for Complex Analytics**: Dispatch heavy multi-warehouse inventory forecasting or supplier lead-time simulations to Laravel Redis queues with WebSocket notification via Laravel Reverb.
3. **Semantic Vector Search (pgvector)**: Add PostgreSQL `pgvector` embeddings on stone color patterns and vein descriptions (e.g., "warm marble with gold spider veins") for fuzzy visual similarity matching.
4. **Multi-Item Purchase Order Draft Editing**: Allow staff to conversational modify existing drafts (e.g. *"Change the quantity of Carrara to 30 slabs"*) prior to final confirmation.

---

## 10. Test Suite Verification

Run the automated PHPUnit test suite:
```bash
php vendor/bin/phpunit tests/Feature/
```

Results:
```text
OK (15 tests, 61 assertions)
```
Tests verify:
- Stock checking in Houston (42 slabs) and Dallas (18 slabs) for 3cm Calacatta.
- Conversation follow-up context retention ("And in Dallas?").
- Polite refusal for Sales asking landed costs.
- Complete landed cost breakdown for Purchasing on PO-1023.
- Draft PO creation and confirmation workflow.
- Delayed PO queries for Supplier X.
- Prompt injection blocking.

---

## 11. 5–10 Minute Video Walkthrough Outline

Here is the recommended script for your submission recording:

1. **Introduction & Architecture Overview (1.5 min)**:
   - Introduce the ERP assistant built for natural stone & quartz distribution.
   - Show `docker-compose.yml` and the 1-command startup.
   - Explain the 2 roles (Sales vs Purchasing) and the separation of concerns between tools and AI models.
2. **Sales Role Demonstration (2 min)**:
   - Log in as Sarah Jenkins (Sales).
   - Ask: *"How many 3cm Calacatta slabs do we have in Houston?"* -> Highlight the 42 slabs answer coming directly from `checkStock`.
   - Ask follow-up: *"And in Dallas?"* -> Highlight context retention (18 slabs).
   - Ask: *"What is the landed cost per slab on PO-1023?"* -> Show the in-tool role check triggering the polite refusal: `"Cost details are only available to the Purchasing team."`
3. **Purchasing Role & Confirm-Before-Write Flow (2.5 min)**:
   - Switch role to Peter Vance (Purchasing).
   - Re-ask: *"What is the landed cost per slab on PO-1023?"* -> Show full landed cost breakdown (\$150 and \$115 per slab) with quantity-based freight allocation explanation.
   - Ask: *"Create a draft PO for 20 slabs of 2cm Carrara from Supplier Y."* -> Show the assistant preparing the draft and asking for confirmation without writing to the database.
   - Reply: *"confirm"* -> Show PO-1016 successfully created in PostgreSQL.
   - Ask: *"Which purchase orders from Supplier X are delayed?"* -> Show delayed POs listed.
4. **Codebase Walkthrough & TypeScript Agent (2 min)**:
   - Walk through `LandedCostService.php`, `ToolManager.php`, and `AssistantService.php`.
   - Show `ts-agent/` running in parallel and demonstrate the seamless toggle between Laravel and TypeScript agents.
   - Conclude with the 15 passing PHPUnit tests and security protections.
