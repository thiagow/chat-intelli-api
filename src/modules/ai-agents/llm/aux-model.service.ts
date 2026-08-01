import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  defaultModelsFor,
  type LlmProviderName,
} from './llm.constants';

/**
 * Resolve o modelo usado pelos serviços auxiliares — classificador de
 * intenção, extração de memória, judge de evals, reranker do RAG.
 *
 * Esses serviços não pertencem a nenhum agente, então não têm um `modelId`
 * de onde derivar o provedor. Antes eram fixos em Sakana, o que os fazia
 * falhar (`SAKANA_API_KEY not set`) mesmo num deploy que só usa OpenAI.
 *
 * Resolução, em ordem:
 *   1. `AUX_LLM_PROVIDER` (`sakana` | `openai`) — override explícito.
 *   2. `SAKANA_API_KEY` presente → sakana (preserva deploys existentes).
 *   3. Senão → openai.
 *
 * O `simple` é o que todos usam hoje; `conversation` fica exposto pra quando
 * algum auxiliar precisar de mais qualidade.
 */
@Injectable()
export class AuxModelService {
  private readonly logger = new Logger(AuxModelService.name);
  private readonly provider: LlmProviderName;

  constructor(config: ConfigService) {
    const override = (config.get<string>('AUX_LLM_PROVIDER') ?? '')
      .trim()
      .toLowerCase();

    if (override === 'openai' || override === 'sakana') {
      this.provider = override;
    } else {
      if (override) {
        this.logger.warn(
          `AUX_LLM_PROVIDER="${override}" inválido — use "sakana" ou "openai". Caindo no fallback automático.`,
        );
      }
      this.provider = config.get<string>('SAKANA_API_KEY') ? 'sakana' : 'openai';
    }

    this.logger.log(`Aux LLM provider: ${this.provider}`);
  }

  /** Modelo barato — o default de todo serviço auxiliar. */
  get simpleModel(): string {
    return defaultModelsFor(this.provider).simple;
  }

  /** Modelo de conversa do mesmo provedor, para auxiliares que precisem. */
  get conversationModel(): string {
    return defaultModelsFor(this.provider).conversation;
  }
}
