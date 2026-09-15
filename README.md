# Intelli Chat — API

**Backend da Intelli Chat**, uma plataforma de atendimento omnichannel: mensagens de WhatsApp, Instagram e Gmail chegam, são normalizadas, roteadas para agentes de IA (ou chatbot) e respondidas — com handoff para humano quando necessário. Arquitetura orientada a filas, multi-tenant desde o design, com automações reativas e um subsistema completo de agentes de IA com roteamento de custo, RAG e ferramentas.

Consumido pelo frontend [`chat-intelli-web`](../chat-intelli-web) via REST + Socket.IO e exposto de forma somente-leitura ao [`chat-intelli-mcp`](../chat-intelli-mcp) para integração com Claude.

> Comentários e documentação majoritariamente em português (pt-BR); identificadores de código em inglês.

---

## Stack

| Camada | Tecnologia |
|---|---|
| Framework | [NestJS 11](https://nestjs.com) |
| Banco de dados | [PostgreSQL](https://www.postgresql.org) + [Prisma 6](https://www.prisma.io) + [pgvector](https://github.com/pgvector/pgvector) (busca semântica) |
| Filas | [BullMQ](https://docs.bullmq.io) sobre [Redis](https://redis.io) (`ioredis`) |
| Tempo real | Socket.IO (`@nestjs/platform-socket.io`) |
| Auth | JWT (`@nestjs/jwt`) + Passport (estratégia JWT + API key custom) |
| IA / LLM | OpenAI SDK (compatível com múltiplos provedores) — OpenAI e Sakana |
| Validação | class-validator + class-transformer |
| Documentação de API | Swagger (`@nestjs/swagger`), auto-gerado em `/docs` |
| Storage | Disco local (dev) / Cloudflare R2 (`@aws-sdk/client-s3`, produção) |
| Segurança | Helmet |
| Notificações push | `web-push` |
| Testes | Jest (unitários) |
| Linguagem | TypeScript (strict) |

---

## Funcionalidades

### 🔌 Channel Hub — arquitetura de portas e adaptadores
Cada canal (WhatsApp via Zappfy/UAZAPI, WhatsApp Official API, Instagram, Gmail) é um adaptador autocontido implementando três portas (`InboundChannelPort`, `OutboundChannelPort`, `HistorySyncPort` opcional), registrado em um registry central por `ChannelType`. Adicionar um canal novo não exige tocar em nada a jusante do pipeline de mensagens normalizadas. Gmail é o único canal por polling (cron via BullMQ); os demais recebem webhooks.

### 📨 Pipeline de mensagens assíncrono e idempotente
Webhook → persistência do payload bruto (fonte de verdade para replay) → fila `inbound-messages` → resolução de contato/conversa → persistência → emissão em tempo real → evento de outbox → execução de agente com debounce (10s) para agrupar rajadas de mensagens do cliente em uma única resposta.

### 🤖 Agentes de IA — o maior subsistema
- **Roteamento determinístico** de conversa para agente (sem LLM na decisão): conversa em andamento mantém o agente ativo; caso contrário, o orquestrador autônomo do canal assume, com fallback ao primeiro worker disponível.
- **Loop de tool-calling** com limites de iteração e profundidade de delegação entre agentes (agent-to-agent), com guardas de comportamento deliberadas (uma única bolha de saída por execução, nudge sintético quando ferramentas rodam sem gerar resposta).
- **Roteamento de custo por modelo**: iterações de ferramentas sempre usam o modelo mais barato do provedor; apenas a síntese final escala de modelo, e só para agentes worker — o orquestrador permanece barato. Overrides por agente são configuráveis via JSON, sem migração.
- **RAG com pgvector**: base de conhecimento indexada e consultada via SQL raw, com reranking.
- **Ferramentas built-in e configuráveis**: delegação entre agentes, resposta à conversa, transferência para humano (via fila de ações pendentes, com aprovação quando exigida), ferramentas HTTP e SQL definidas no banco.
- **Framework de evals** com datasets por agente e LLM-judge, rodando headless via `NestFactory.createApplicationContext`, integrado ao CI (roda em PRs que tocam o módulo de agentes; falha abaixo de 80 de score médio).

### 🔁 Automações — outbox transacional
Módulo global de outbox: qualquer módulo de domínio emite eventos de automação dentro da mesma transação Prisma da mutação de negócio, com dedupe por chave e drenagem via worker dedicado — garantindo que nenhum gatilho de automação se perca por falha entre a escrita e o disparo.

### 🔐 Multi-tenancy e controle de acesso
Guards por controller (`JwtAuthGuard`, `OrgGuard`, `RolesGuard`); `OrgGuard` exige header de organização, valida associação e popula ACL de canais por usuário (papéis OWNER/ADMIN com acesso total, AGENT com lista explícita). Integrações externas autenticam via API key contra um módulo de API pública dedicado.

### ⏱️ Filas de trabalho dedicadas
Mensagens de entrada/saída, processamento de chatbot, roteamento de conversa, timers de SLA, notificações, processamento de mídia, indexação de RAG/base de conhecimento, extração de memória, sincronização de canal, hidratação de avatar, watchdog e recuperação de vendas — cada uma isolada com seu próprio consumidor.

---

## Arquitetura

```
src/
├── main.ts                     # bootstrap, Helmet, CORS, Swagger
├── app.module.ts                # módulo raiz, registro de todas as filas BullMQ
├── common/                       # filtros globais, interceptors, exceptions, guards
├── config/                        # carregadores de configuração de ambiente
├── database/                       # módulo Prisma
└── modules/
    ├── channel-hub/                  # adaptadores de canal (portas & adaptadores)
    │   ├── ports/                       # InboundChannelPort, OutboundChannelPort, HistorySyncPort
    │   └── adapters/                     # zappfy, uazapi, whatsapp-official, instagram, gmail
    ├── messaging/                     # pipeline de mensagens, conversas, FSM de estado
    ├── realtime/                       # gateway Socket.IO
    ├── ai-agents/                       # router, runner, model-router, llm, prompts, rag, tools
    │   ├── router/                          # seleção determinística de agente
    │   ├── runner/                           # loop de tool-calling + roteamento de custo
    │   ├── rag/ knowledge/                    # pgvector, base de conhecimento
    │   ├── tools/                              # built-in + HTTP/SQL configuráveis
    │   ├── confirmations/                       # ações pendentes de aprovação
    │   └── evals/                                 # datasets + LLM judge
    ├── chatbot/                         # fluxos de decisão sem IA generativa
    ├── automations/                     # outbox transacional (módulo @Global)
    ├── organizations/ users/ iam/       # multi-tenancy, IAM, channel-access
    ├── pipelines/ segments/            # CRM leve
    ├── sales-recovery/                  # automação de recuperação de carrinho
    ├── inbox-views/                       # query builder dinâmico de filtros
    ├── tags/ quick-replies/ ratings/    # metadados
    └── public-api/                        # autenticação por API key para integrações externas
```

### Fluxo de dados

```
Cliente (WhatsApp/Instagram/Gmail)
        │  webhook
        ▼
webhook-gateway.controller  ──▶  persiste payload bruto  ──▶  fila inbound-messages
        │
        ▼
inbound-message.processor
  ├─ resolve idempotência / contato / conversa
  ├─ persiste mensagem
  ├─ emite evento em tempo real (Socket.IO)
  └─ debounce (10s) ──▶ agent-router ──▶ agent-runner (tool-calling loop)
                                                │
                                                ▼
                                    fila outbound-messages ──▶ adaptador do canal
```

### Decisões técnicas que valeram a pena documentar

- **Roteamento de agente sem LLM.** A escolha de qual agente responde é determinística (estado da conversa + hierarquia orquestrador/worker), não uma classificação por modelo — mais previsível, mais barato e mais rápido de depurar.
- **Prompts em camadas compostas.** Segurança (imutável, isolamento de tenant + anti-injeção), personalidade, capacidades e contexto são camadas separadas, montadas em ordem fixa via template, com RAG injetado por último.
- **Outbox transacional para automações.** Eventos de negócio nunca se perdem entre a escrita no banco e o disparo da automação, porque são gravados na mesma transação.
- **Transferência para humano é sempre assíncrona.** Nunca acontece "na hora" dentro do loop do agente — vira uma ação pendente crítica em fila, com um roteiro de resposta imediata para o agente, evitando estados inconsistentes de handoff.
- **Custo como restrição de arquitetura, não como otimização posterior.** O modelo caro só é usado na síntese final de agentes worker; toda iteração intermediária de ferramentas usa o modelo mais barato do mesmo provedor.

---

## Rodando localmente

```bash
npm install

# variáveis de ambiente (ver .env.example)
# DATABASE_URL, REDIS_*, JWT_SECRET, OPENAI_API_KEY, etc.

npm run prisma:generate
npm run prisma:migrate

npm run start:dev          # http://localhost:3001 — Swagger em /docs
```

```bash
npm test                   # suíte Jest (unitários)
npm run typecheck          # tsc --noEmit — gate de qualidade (sem ESLint configurado)
npm run evals               # avaliação completa de agentes de IA (requer DB + Redis + chaves de API)
npm run evals:agent "Nome do Agente"
```

Requer PostgreSQL (com extensão `pgvector`) e Redis rodando. Em produção, storage de arquivos exige as quatro variáveis `R2_*` (Cloudflare R2) — disco local não sobrevive a redeploys.

## Deploy

Container Docker executa `prisma migrate deploy` na inicialização. Node 20 fixo (dependências não compatíveis com Node ≥ 22 são evitadas deliberadamente).

---

## Sobre este projeto

A Intelli Chat nasceu para resolver um problema operacional real: atendimento multi-canal que não trava quando o volume cresce, com IA que responde de forma consistente e barata, e automações que não perdem eventos. Este backend é onde essas garantias são implementadas — filas em vez de chamadas síncronas, transações em vez de best-effort, e uma arquitetura de agentes desenhada para custo e previsibilidade desde o primeiro dia.

Repositórios relacionados: [`chat-intelli-web`](../chat-intelli-web) (frontend Next.js) · [`chat-intelli-mcp`](../chat-intelli-mcp) (servidor MCP para integração com Claude)
