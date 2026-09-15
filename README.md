# Intelli Chat — API

**Backend of Intelli Chat**, an omnichannel customer-service platform: WhatsApp, Instagram, and Gmail messages arrive, get normalized, get routed to AI agents (or a chatbot), and get answered — with human handoff when needed. Queue-driven architecture, multi-tenant by design, with reactive automations and a full AI-agent subsystem featuring cost routing, RAG, and tool use.

Consumed by the [`chat-intelli-web`](../chat-intelli-web) frontend via REST + Socket.IO, and exposed read-only to [`chat-intelli-mcp`](../chat-intelli-mcp) for Claude integration.

---

## Stack

| Layer | Technology |
|---|---|
| Framework | [NestJS 11](https://nestjs.com) |
| Database | [PostgreSQL](https://www.postgresql.org) + [Prisma 6](https://www.prisma.io) + [pgvector](https://github.com/pgvector/pgvector) (semantic search) |
| Queues | [BullMQ](https://docs.bullmq.io) on top of [Redis](https://redis.io) (`ioredis`) |
| Realtime | Socket.IO (`@nestjs/platform-socket.io`) |
| Auth | JWT (`@nestjs/jwt`) + Passport (JWT strategy + custom API-key strategy) |
| AI / LLM | OpenAI SDK (multi-provider compatible) — OpenAI and Sakana |
| Validation | class-validator + class-transformer |
| API docs | Swagger (`@nestjs/swagger`), auto-generated at `/docs` |
| Storage | Local disk (dev) / Cloudflare R2 (`@aws-sdk/client-s3`, production) |
| Security | Helmet |
| Push notifications | `web-push` |
| Testing | Jest (unit) |
| Language | TypeScript (strict) |

---

## Features

### 🔌 Channel Hub — ports & adapters architecture
Each channel (WhatsApp via Zappfy/UAZAPI, WhatsApp Official API, Instagram, Gmail) is a self-contained adapter implementing three ports (`InboundChannelPort`, `OutboundChannelPort`, an optional `HistorySyncPort`), registered in a central registry keyed by `ChannelType`. Adding a new channel requires no changes downstream of the normalized message pipeline. Gmail is the only polling-based channel (BullMQ cron); the rest receive webhooks.

### 📨 Async, idempotent message pipeline
Webhook → raw payload persisted (source of truth for replay) → `inbound-messages` queue → contact/conversation resolution → persistence → realtime emission → outbox event → agent run with a 10-second debounce that collapses customer message bursts into a single response.

### 🤖 AI agents — the largest subsystem
- **Deterministic agent routing** (no LLM in the decision loop): an in-flight conversation keeps its active agent; otherwise the channel's autonomous orchestrator takes over, falling back to the first available worker.
- **Tool-calling loop** with iteration and delegation-depth limits for agent-to-agent handoff, plus deliberate behavioral guards (a single outbound reply per run, a synthetic nudge when tools ran but produced no response).
- **Per-model cost routing**: tool iterations always use the provider's cheapest model; only the final synthesis escalates to a stronger model, and only for worker agents — the orchestrator always stays cheap. Per-agent overrides are configurable via JSON, no migration required.
- **RAG on pgvector**: a knowledge base indexed and queried via raw SQL, with reranking.
- **Built-in and configurable tools**: agent-to-agent delegation, replying to the conversation, human handoff (via a pending-actions queue with approval when required), and database-configured HTTP/SQL tools.
- **Evaluation framework** with per-agent datasets and an LLM judge, running headless via `NestFactory.createApplicationContext`, wired into CI (runs on PRs touching the agents module; fails below an average score of 80).

### 🔁 Automations — transactional outbox
A global outbox module: any domain module emits automation events inside the same Prisma transaction as the business mutation, with dedup keys and a dedicated worker drain — ensuring no automation trigger is ever lost between the write and the dispatch.

### 🔐 Multi-tenancy & access control
Per-controller guards (`JwtAuthGuard`, `OrgGuard`, `RolesGuard`); `OrgGuard` requires an organization header, verifies membership, and populates per-user channel ACLs (OWNER/ADMIN get full access, AGENT gets an explicit allow-list). External integrations authenticate via API key against a dedicated public-API module.

### ⏱️ Dedicated work queues
Inbound/outbound messages, chatbot processing, conversation routing, SLA timers, notifications, media processing, RAG/knowledge indexing, memory extraction, channel sync, avatar hydration, a watchdog, and sales recovery — each isolated behind its own consumer.

---

## Architecture

```
src/
├── main.ts                     # bootstrap, Helmet, CORS, Swagger
├── app.module.ts                # root module, registers all BullMQ queues
├── common/                       # global filters, interceptors, exceptions, guards
├── config/                        # environment configuration loaders
├── database/                       # Prisma module
└── modules/
    ├── channel-hub/                  # channel adapters (ports & adapters)
    │   ├── ports/                       # InboundChannelPort, OutboundChannelPort, HistorySyncPort
    │   └── adapters/                     # zappfy, uazapi, whatsapp-official, instagram, gmail
    ├── messaging/                     # message pipeline, conversations, state machine
    ├── realtime/                       # Socket.IO gateway
    ├── ai-agents/                       # router, runner, model-router, llm, prompts, rag, tools
    │   ├── router/                          # deterministic agent selection
    │   ├── runner/                           # tool-calling loop + cost routing
    │   ├── rag/ knowledge/                    # pgvector, knowledge base
    │   ├── tools/                              # built-in + configurable HTTP/SQL
    │   ├── confirmations/                       # pending actions requiring approval
    │   └── evals/                                 # datasets + LLM judge
    ├── chatbot/                         # non-generative decision-tree flows
    ├── automations/                     # transactional outbox (a @Global module)
    ├── organizations/ users/ iam/       # multi-tenancy, IAM, channel access
    ├── pipelines/ segments/            # lightweight CRM
    ├── sales-recovery/                  # cart-abandonment automation
    ├── inbox-views/                       # dynamic filter query builder
    ├── tags/ quick-replies/ ratings/    # metadata
    └── public-api/                        # API-key auth for external integrations
```

### Data flow

```
Customer (WhatsApp / Instagram / Gmail)
        │  webhook
        ▼
webhook-gateway.controller  ──▶  persist raw payload  ──▶  inbound-messages queue
        │
        ▼
inbound-message.processor
  ├─ idempotency claim / contact resolve / conversation resolve
  ├─ persist message
  ├─ emit realtime event (Socket.IO)
  └─ debounce (10s) ──▶ agent-router ──▶ agent-runner (tool-calling loop)
                                                │
                                                ▼
                                    outbound-messages queue ──▶ channel adapter
```

### Technical decisions worth documenting

- **No-LLM agent routing.** Deciding which agent answers is deterministic (conversation state + orchestrator/worker hierarchy), not an LLM classification step — more predictable, cheaper, and far easier to debug.
- **Layered, composable prompts.** Security (immutable, tenant isolation + anti-injection), personality, capabilities, and context are separate layers, assembled in a fixed order via a template, with RAG appended last.
- **Transactional outbox for automations.** Business events are never lost between the database write and the automation firing, because they're written in the same transaction.
- **Human handoff is always asynchronous.** It never happens "on the spot" inside the agent loop — it becomes a critical pending action in a queue, with an immediate response script for the agent, avoiding inconsistent handoff states.
- **Cost as a design constraint, not a later optimization.** The expensive model is only used for the final synthesis of worker agents; every intermediate tool iteration uses the same provider's cheapest model.

---

## Running locally

```bash
npm install

# environment variables (see .env.example)
# DATABASE_URL, REDIS_*, JWT_SECRET, OPENAI_API_KEY, etc.

npm run prisma:generate
npm run prisma:migrate

npm run start:dev          # http://localhost:3001 — Swagger at /docs
```

```bash
npm test                   # Jest suite (unit)
npm run typecheck          # tsc --noEmit — the de-facto quality gate (no ESLint configured)
npm run evals               # full AI agent evaluation (requires DB + Redis + API keys)
npm run evals:agent "Agent Name"
```

Requires PostgreSQL (with the `pgvector` extension) and Redis running. In production, file storage requires all four `R2_*` variables (Cloudflare R2) — local disk doesn't survive redeploys.

## Deploy

The Docker container runs `prisma migrate deploy` on startup. Pinned to Node 20 (dependencies requiring Node ≥ 22 are deliberately avoided).

---

## About this project

Intelli Chat was built to solve a real operational problem: multi-channel customer service that doesn't fall over as volume grows, AI that answers consistently and cheaply, and automations that never drop an event. This backend is where those guarantees are implemented — queues instead of synchronous calls, transactions instead of best-effort, and an agent architecture designed for cost and predictability from day one.

---

## The Intelli Chat ecosystem

This repository is one of three pieces that make up the platform:

### ⚙️ [`chat-intelli-api`](.) — *this repository*
Backend built with NestJS 11, the platform's brain. Receives WhatsApp/Instagram/Gmail messages via webhook, processes them through an async, queue-driven pipeline (BullMQ + Redis), and routes them to AI agents with tool-calling, RAG (pgvector), and per-model cost routing. Automations run on a transactional outbox; multi-tenancy and per-channel ACLs are enforced via guards throughout the API. Persistence in PostgreSQL via Prisma.

### 🖥️ [`chat-intelli-web`](../chat-intelli-web)
Frontend built with Next.js 16 + React 19. The product's interface: realtime inbox, visual chatbot/automation builders, an AI agents control center, pipelines, and settings — a pure API client with no server-side logic of its own.

### 🔌 [`chat-intelli-mcp`](../chat-intelli-mcp)
A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes this API's dashboard indicators as read-only tools for Claude — ask the assistant directly about service metrics without leaving Claude Code/Desktop. A thin, per-session multi-tenant proxy with no state or business logic of its own.
