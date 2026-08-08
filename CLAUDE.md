# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Chat BullQ (package name `chat-bullq-api`) — omnichannel customer-service API. NestJS 11 + Prisma 6 (PostgreSQL) + BullMQ (Redis) + Socket.IO. Customers reach the org over WhatsApp / Instagram / Gmail; AI agents and chatbot flows answer, with human takeover.

Much of the inline documentation is in Brazilian Portuguese — comments and commit messages follow that convention, code identifiers are English.

## Commands

```bash
npm run start:dev          # watch mode, http://localhost:3001 (Swagger at /docs)
npm run build              # nest build
npm run typecheck          # tsc --noEmit — the de-facto lint gate (no ESLint configured)
npm test                   # jest, unit specs only
npx jest path/to/file.spec.ts          # single file
npx jest -t "name of the test"         # single test by name
npm run prisma:migrate     # prisma migrate dev
npm run prisma:generate    # regenerate client after schema edits
npm run prisma:seed        # ts-node prisma/seed.ts
npm run prisma:studio
npm run evals              # LLM prompt evals, all datasets (needs DB + Redis + API keys)
npm run evals:agent "Daniel Souza"     # single agent dataset
```

Tests live beside the code as `*.spec.ts` under `src/` (jest `rootDir` is `src`). There is no e2e suite. CI ([.github/workflows/evals.yml](.github/workflows/evals.yml)) runs typecheck + evals on PRs touching `src/modules/ai-agents/**`; evals fail the build below an average score of 80.

Global prefix is `api/v1`. Path alias `@/*` → `src/*`.

## Architecture

### Request/message flow

The core path is asynchronous and queue-driven — HTTP controllers rarely do the real work.

1. **[webhook-gateway.controller.ts](src/modules/channel-hub/webhook-gateway.controller.ts)** — single public endpoint `POST /webhooks/:channelType`. Extracts *locators* from the payload (one payload can map to several channels), resolves `Channel` rows, validates the signature per channel, persists the raw payload to `webhook_events` **before** enqueuing (source of truth for replay), then pushes normalized messages onto the `inbound-messages` queue.
2. **[inbound-message.processor.ts](src/modules/messaging/pipeline/inbound-message.processor.ts)** — idempotency claim → contact resolve → conversation resolve → persist message → emit realtime → outbox event → debounced agent run. The debounce (10s, in-memory, keyed by conversation) collapses customer message bursts into one agent run; an in-flight run sets a `followupNeeded` flag rather than starting a parallel run.
3. **Agent or chatbot answers**, replying through the `outbound-messages` queue, which dispatches via the channel's outbound adapter.

### Channel Hub (ports & adapters)

[src/modules/channel-hub/](src/modules/channel-hub/) isolates provider quirks behind three ports in [ports/](src/modules/channel-hub/ports/): `InboundChannelPort` (extractLocators / matchesChannel / validateWebhook / parseWebhook), `OutboundChannelPort`, `HistorySyncPort` (optional backfill). Each provider (`zappfy`, `uazapi`, `whatsapp-official`, `instagram`, `gmail`) is a self-contained module registering itself into [ChannelAdapterRegistry](src/modules/channel-hub/channel-adapter.registry.ts) keyed by `ChannelType`.

**Adding a channel:** new `ChannelType` enum value + migration, a folder under `adapters/`, implement the ports, register in the registry, import the module in `ChannelHubModule`. Nothing downstream of the normalized message types should need changes. Gmail is the outlier — it polls on a BullMQ cron instead of receiving webhooks.

### AI agents

[src/modules/ai-agents/](src/modules/ai-agents/) is the largest subsystem:

- **[router/agent-router.service.ts](src/modules/ai-agents/router/agent-router.service.ts)** + **[classifier/](src/modules/ai-agents/classifier/)** — a cheap model classifies intent/confidence *before* any agent runs, and picks the agent. High-confidence `SPAM_OR_NOISE` short-circuits the whole run.
- **[runner/agent-runner.service.ts](src/modules/ai-agents/runner/agent-runner.service.ts)** — the tool-calling loop (`MAX_TOOL_ITERATIONS = 8`, `MAX_CHAIN_DEPTH = 3` for agent-to-agent delegation). Contains several deliberate behavioral guards (one outbound bubble per run, synthetic nudge when sales-prep tools ran but no reply was sent) — read the comments before changing them.
- **[runner/model-router.service.ts](src/modules/ai-agents/runner/model-router.service.ts)** — cost routing. Tool iterations always use the provider's cheap model; only the final synthesis escalates, and only for `WORKER` agents (the `ORCHESTRATOR` stays cheap). The **provider pair is derived from the agent's own `modelId`** (`openai/*` → gpt-4o-mini/gpt-4o, anything else → sakana fugu/fugu-ultra). Per-agent overrides live in the existing `AiAgent.modelParams.routing` JSON column — no migration needed.
- **[llm/](src/modules/ai-agents/llm/)** — two providers, Sakana and OpenAI, both via the OpenAI-compatible SDK. `AUX_LLM_PROVIDER` selects the provider for agent-less services (classifier, memory extraction, eval judge, RAG reranker) since those have no `modelId` to infer from.
- **[prompts/](src/modules/ai-agents/prompts/)** — four composable layers in fixed order: `security` (immutable, tenant isolation + anti-injection), `personality`, `capabilities`, `context`.
- **[rag/](src/modules/ai-agents/rag/)** + **[knowledge/](src/modules/ai-agents/knowledge/)** — pgvector. The `ai_vector_entries` table is **not** in `schema.prisma` (Prisma can't model `vector(1536)`); it is created by migration and queried via raw SQL in [vector-store.service.ts](src/modules/ai-agents/rag/vector-store.service.ts), whose header documents the DDL.
- **[tools/](src/modules/ai-agents/tools/)** — built-in tools (`delegateToAgent`, `replyToConversation`, `transferToHuman`, …) plus DB-configured HTTP and SQL tools executed by `http-tool-executor` / `sql-tool-executor`.
- **[confirmations/](src/modules/ai-agents/confirmations/)** — skills flagged as needing approval create an `AiPendingAction` and execute later via queue instead of running inline.
- **[evals/](src/modules/ai-agents/evals/)** — datasets per agent + LLM judge. Runs headless via `NestFactory.createApplicationContext(AppModule)`, so it boots the whole app graph.

[docs/orchestration-improvements-from-bullq.md](docs/orchestration-improvements-from-bullq.md) records the design rationale behind the classifier / confidence routing / layered prompts work.

### Automations (transactional outbox)

[AutomationsModule](src/modules/automations/automations.module.ts) is `@Global` and registered early in `AppModule` so any domain module can inject `OutboxService` without importing it.

Domain code emits events **inside the same Prisma transaction as the mutation**:

```ts
await this.prisma.$transaction(async (tx) => {
  await tx.conversationTag.create({ ... });
  await this.outbox.enqueue(tx, AutomationTrigger.TAG_ADDED, payload);
});
```

`enqueuePostCommit` is the deprecated non-transactional fallback. Payloads must carry `organizationId` and `contactId` (the latter is the worker's lock key) — missing either throws at write time. A unique index on `dedupKey` collapses re-deliveries; per-trigger keys are derived in `deriveDedupKey`. [outbox-poller.service.ts](src/modules/automations/outbox/outbox-poller.service.ts) drains rows into the automation worker.

### Multi-tenancy & auth

Guards are applied **per-controller**, not globally: `@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)`. [OrgGuard](src/common/guards/org.guard.ts) requires an `x-organization-id` header, verifies membership, and populates `request.organization` and `request.accessibleChannelIds` (channel-level ACL from [iam/channel-access](src/modules/iam/channel-access/)). Read them via the `@CurrentOrg()` / `@CurrentChannelAccess()` decorators. `@Public()` opts a route out. Every query must be scoped by `organizationId` — nothing enforces it automatically.

External integrations authenticate with API keys ([ApiKeyAuthGuard](src/common/guards/api-key-auth.guard.ts)) against the [public-api](src/modules/public-api/) module.

### Queues

All BullMQ, shared Redis connection configured in [app.module.ts](src/app.module.ts). Notable ones: `inbound-messages`, `outbound-messages`, `chatbot-processor`, `conversation-router`, `sla-timers`, `notifications`, `media-processor`, `rag-indexer`, `knowledge-indexer`, `memory-extractor`, plus channel-sync, avatar-hydration, watchdog and sales-recovery queues declared as constants in their modules. Producers `registerQueue` the same name as the consuming module — declaring a queue does not mean the module consumes it.

### Conventions

- Module layout: `controller` → `service` → `repository` (repository holds the Prisma calls), DTOs in `dto/` with `class-validator`. The global `ValidationPipe` uses `whitelist` + `forbidNonWhitelisted`, so undeclared body properties are rejected.
- `ResponseInterceptor` wraps all responses; `GlobalExceptionFilter` normalizes errors.
- Conversation state transitions go through [conversation-fsm.service.ts](src/modules/messaging/conversations/conversation-fsm.service.ts), not direct status writes.
- File storage swaps by env: local disk under `uploads/` in dev, Cloudflare R2 when all four `R2_*` vars are set (required in production — local disk doesn't survive redeploys).
- `ProductsModule` is intentionally not registered (see the comment in [app.module.ts](src/app.module.ts)); the catalog now lives in Trivapp, consumed via an HTTP skill. The module is still fully implemented and `products.service.ts` still holds live Prisma queries — it is unreachable because it never enters the DI graph, not because the code was removed. The `products` table is orphaned. Note the skill's LLM-facing name is `lookupOffering`, not `getProductPitch` — the file [get-product-pitch.tool.ts](src/modules/ai-agents/tools/builtin/get-product-pitch.tool.ts) keeps the old name but its `name` property was deliberately renamed.
- Deployment: [Dockerfile](Dockerfile) runs `prisma migrate deploy` on start. Node 20 — do not add dependencies requiring Node ≥ 22 (`unpdf` is pinned to 1.7.0 for this reason).
