import { Injectable, Logger } from '@nestjs/common';

import { defaultModelsFor, providerOf } from '../llm/llm.constants';

/**
 * Fase da chamada LLM dentro de um turno do agente.
 *  - `tool`      → iteração que (provavelmente) vai pedir/encadear ferramentas.
 *                  É mecânico: sempre roda no modelo barato (fugu).
 *  - `synthesis` → a resposta final ao cliente. Aqui é onde a qualidade pesa,
 *                  então workers escalam pro fugu-ultra; o orquestrador (triagem)
 *                  fica no fugu.
 */
export type LlmPhase = 'tool' | 'synthesis';

export type AgentKind = 'ORCHESTRATOR' | 'WORKER';

/**
 * Override opcional por agente, gravado em `AiAgent.modelParams.routing`
 * (coluna JSON já existente — sem migration). Ex.:
 *   { "routing": { "primary": "sakana/fugu",
 *                  "escalation": "sakana/fugu-ultra-20260615",
 *                  "alwaysPrimary": false,
 *                  "escalateSynthesis": true } }
 */
interface RoutingOverride {
  primary?: string;
  escalation?: string;
  /** Trava o agente inteiro no modelo barato (nunca escala). */
  alwaysPrimary?: boolean;
  /** Força/inibe escalonamento da síntese independente do kind. */
  escalateSynthesis?: boolean;
}

export interface SelectModelInput {
  agentKind: AgentKind;
  /**
   * `AiAgent.modelId` — modelo de escalonamento default E fonte do provedor
   * que define o par de modelos (barato/conversa) usado no turno todo.
   */
  modelId: string;
  /** `AiAgent.modelParams` cru do banco. */
  modelParams?: Record<string, unknown> | null;
  phase: LlmPhase;
}

/**
 * Decide qual modelo usar em cada chamada do loop do agente.
 *
 * Estratégia (objetivo: usar o modelo barato sempre que possível, escalando
 * só quando a qualidade importa):
 *  - Toda iteração de ferramenta roda no modelo barato do provedor.
 *  - A síntese final:
 *      • WORKER (especialista de vendas/suporte/impl) → escala pro modelo de
 *        conversa (é a resposta que o cliente lê; qualidade importa).
 *      • ORCHESTRATOR (Augusto, triagem/small-talk/ambíguo) → fica no barato.
 *  - Qualquer agente pode sobrescrever via `modelParams.routing`.
 *
 * O PAR de modelos (barato/conversa) é derivado do provedor do próprio
 * agente: um agente `openai/*` roda ferramentas no gpt-4o-mini, um agente
 * `sakana/*` roda no fugu. Antes o barato era fixo em Sakana, o que fazia
 * TODO agente OpenAI quebrar na primeira iteração com "SAKANA_API_KEY not
 * set" — o modelId do agente só alimentava o escalation, e a fase `tool`
 * nunca chega lá.
 */
@Injectable()
export class ModelRouterService {
  private readonly logger = new Logger(ModelRouterService.name);

  selectModel(input: SelectModelInput): string {
    const routing = this.parseRouting(input.modelParams);
    const defaults = defaultModelsFor(providerOf(input.modelId));

    // Sanitiza pra GARANTIR que só saem modelos suportados (Sakana ou
    // OpenAI). Agentes legados podem ter `modelId` antigo (ex.:
    // "claude-sonnet-4-6") que ainda não foi migrado — nesse caso
    // `providerOf` devolve 'sakana' e os defaults abaixo mantêm o
    // comportamento antigo em vez de quebrar no provider.
    const primary = this.sanitizeModel(routing.primary, defaults.simple);
    const escalation = this.sanitizeModel(
      routing.escalation ?? input.modelId,
      defaults.conversation,
    );

    if (routing.alwaysPrimary) return primary;

    // Iterações de ferramenta são sempre baratas.
    if (input.phase === 'tool') return primary;

    // Síntese final: decide se escala.
    const escalate =
      routing.escalateSynthesis ?? input.agentKind === 'WORKER';

    return escalate ? escalation : primary;
  }

  /**
   * Garante que o modelo é um ID suportado (sakana/*, fugu*, ou openai/*).
   * Qualquer coisa fora disso (modelId legado de Claude/Anthropic/Google,
   * override quebrado, vazio) cai no fallback informado pelo caller.
   */
  private sanitizeModel(model: string | undefined | null, fallback: string): string {
    const m = (model ?? '').trim();
    if (
      m.startsWith('sakana/') ||
      m === 'fugu' ||
      m.startsWith('fugu-') ||
      m.startsWith('openai/')
    ) {
      return m;
    }
    return fallback;
  }

  private parseRouting(
    modelParams: Record<string, unknown> | null | undefined,
  ): RoutingOverride {
    const raw = modelParams?.routing;
    if (!raw || typeof raw !== 'object') return {};
    const r = raw as Record<string, unknown>;
    return {
      primary: typeof r.primary === 'string' ? r.primary : undefined,
      escalation: typeof r.escalation === 'string' ? r.escalation : undefined,
      alwaysPrimary: r.alwaysPrimary === true,
      escalateSynthesis:
        typeof r.escalateSynthesis === 'boolean'
          ? r.escalateSynthesis
          : undefined,
    };
  }
}
