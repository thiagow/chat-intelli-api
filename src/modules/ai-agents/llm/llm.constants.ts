/** Provedores de LLM suportados pelo LlmService. */
export type LlmProviderName = 'sakana' | 'openai';

/** Default Sakana model for cheap/simple background LLM tasks. */
export const SAKANA_SIMPLE_MODEL = 'sakana/fugu';

/** Default Sakana model for customer-facing agent conversations. */
export const SAKANA_CONVERSATION_MODEL = 'sakana/fugu-ultra-20260615';

/** Default OpenAI-compatible base URL for Sakana's API. */
export const SAKANA_DEFAULT_BASE_URL = 'https://api.sakana.ai/v1';

/** Default OpenAI model for cheap/simple background LLM tasks. */
export const OPENAI_SIMPLE_MODEL = 'openai/gpt-4o-mini';

/** Default OpenAI model for customer-facing agent conversations. */
export const OPENAI_CONVERSATION_MODEL = 'openai/gpt-4o';

/**
 * Deduz o provedor a partir do prefixo do model id. Mesma regra usada em
 * `LlmService.resolveModel()` — mantida aqui para que o roteador de modelos
 * consiga escolher os defaults do provedor certo sem depender do service.
 *
 * Ids sem prefixo (`fugu`, `fugu-...`) são Sakana por legado. Qualquer coisa
 * desconhecida cai em Sakana também, preservando o comportamento anterior
 * para agentes com modelId legado (ex.: `claude-sonnet-4-6`).
 */
export function providerOf(modelId: string | undefined | null): LlmProviderName {
  const m = (modelId ?? '').trim();
  if (m.startsWith('openai/')) return 'openai';
  return 'sakana';
}

/**
 * Par de modelos default de um provedor: o barato (iterações de ferramenta)
 * e o de conversa (síntese da resposta final).
 */
export function defaultModelsFor(provider: LlmProviderName): {
  simple: string;
  conversation: string;
} {
  return provider === 'openai'
    ? { simple: OPENAI_SIMPLE_MODEL, conversation: OPENAI_CONVERSATION_MODEL }
    : { simple: SAKANA_SIMPLE_MODEL, conversation: SAKANA_CONVERSATION_MODEL };
}
