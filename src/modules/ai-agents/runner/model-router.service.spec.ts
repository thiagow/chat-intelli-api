import { ModelRouterService, type SelectModelInput } from './model-router.service';
import {
  OPENAI_CONVERSATION_MODEL,
  OPENAI_SIMPLE_MODEL,
  SAKANA_CONVERSATION_MODEL,
  SAKANA_SIMPLE_MODEL,
} from '../llm/llm.constants';

/**
 * Regressão que motivou estes testes: o par de modelos (barato pra fase
 * `tool`, forte pra `synthesis`) era fixo em Sakana, e o `modelId` do agente
 * só alimentava o escalation. Como a PRIMEIRA chamada de todo run é fase
 * `tool`, todo agente OpenAI morria com "SAKANA_API_KEY not set" antes de
 * chegar na síntese — mesmo estando salvo corretamente no banco.
 */
describe('ModelRouterService', () => {
  let service: ModelRouterService;

  beforeEach(() => {
    service = new ModelRouterService();
  });

  const input = (overrides: Partial<SelectModelInput>): SelectModelInput => ({
    agentKind: 'WORKER',
    modelId: OPENAI_CONVERSATION_MODEL,
    modelParams: null,
    phase: 'tool',
    ...overrides,
  });

  describe('agente OpenAI (modelParams vazio — caso da UI)', () => {
    it('usa modelo OpenAI barato na fase de ferramenta', () => {
      const model = service.selectModel(
        input({ modelId: 'openai/gpt-4o-mini', phase: 'tool' }),
      );
      expect(model).toBe(OPENAI_SIMPLE_MODEL);
    });

    it('usa o modelo configurado do agente na síntese (WORKER escala)', () => {
      const model = service.selectModel(
        input({ modelId: 'openai/gpt-4o', agentKind: 'WORKER', phase: 'synthesis' }),
      );
      expect(model).toBe('openai/gpt-4o');
    });

    it('ORCHESTRATOR fica no barato do MESMO provedor na síntese', () => {
      // Este era o segundo caminho quebrado: orquestrador OpenAI caía no
      // `primary`, que era Sakana — nunca tocava OpenAI em nenhuma fase.
      const model = service.selectModel(
        input({ modelId: 'openai/gpt-4o', agentKind: 'ORCHESTRATOR', phase: 'synthesis' }),
      );
      expect(model).toBe(OPENAI_SIMPLE_MODEL);
    });

    it('alwaysPrimary trava no barato do provedor OpenAI, não no Sakana', () => {
      const model = service.selectModel(
        input({
          modelId: 'openai/gpt-4o',
          modelParams: { routing: { alwaysPrimary: true } },
          phase: 'synthesis',
        }),
      );
      expect(model).toBe(OPENAI_SIMPLE_MODEL);
    });

    it.each([
      ['tool' as const, 'WORKER' as const],
      ['tool' as const, 'ORCHESTRATOR' as const],
      ['synthesis' as const, 'WORKER' as const],
      ['synthesis' as const, 'ORCHESTRATOR' as const],
    ])(
      'nunca devolve modelo Sakana — phase=%s kind=%s',
      (phase, agentKind) => {
        const model = service.selectModel(
          input({ modelId: 'openai/gpt-4o', phase, agentKind }),
        );
        expect(model.startsWith('openai/')).toBe(true);
      },
    );
  });

  describe('agente Sakana (comportamento legado — zero regressão)', () => {
    it('usa fugu na fase de ferramenta', () => {
      const model = service.selectModel(
        input({ modelId: SAKANA_CONVERSATION_MODEL, phase: 'tool' }),
      );
      expect(model).toBe(SAKANA_SIMPLE_MODEL);
    });

    it('WORKER escala pro modelo do agente na síntese', () => {
      const model = service.selectModel(
        input({
          modelId: SAKANA_CONVERSATION_MODEL,
          agentKind: 'WORKER',
          phase: 'synthesis',
        }),
      );
      expect(model).toBe(SAKANA_CONVERSATION_MODEL);
    });

    it('ORCHESTRATOR fica no fugu na síntese', () => {
      const model = service.selectModel(
        input({
          modelId: SAKANA_CONVERSATION_MODEL,
          agentKind: 'ORCHESTRATOR',
          phase: 'synthesis',
        }),
      );
      expect(model).toBe(SAKANA_SIMPLE_MODEL);
    });
  });

  describe('overrides via modelParams.routing', () => {
    it('respeita primary e escalation explícitos', () => {
      const params = {
        routing: { primary: 'openai/gpt-4o-mini', escalation: 'openai/gpt-4o' },
      };
      expect(
        service.selectModel(input({ modelParams: params, phase: 'tool' })),
      ).toBe('openai/gpt-4o-mini');
      expect(
        service.selectModel(
          input({ modelParams: params, phase: 'synthesis', agentKind: 'WORKER' }),
        ),
      ).toBe('openai/gpt-4o');
    });

    it('escalateSynthesis=true faz ORCHESTRATOR escalar', () => {
      const model = service.selectModel(
        input({
          modelId: 'openai/gpt-4o',
          agentKind: 'ORCHESTRATOR',
          phase: 'synthesis',
          modelParams: { routing: { escalateSynthesis: true } },
        }),
      );
      expect(model).toBe('openai/gpt-4o');
    });

    it('escalateSynthesis=false impede WORKER de escalar', () => {
      const model = service.selectModel(
        input({
          modelId: 'openai/gpt-4o',
          agentKind: 'WORKER',
          phase: 'synthesis',
          modelParams: { routing: { escalateSynthesis: false } },
        }),
      );
      expect(model).toBe(OPENAI_SIMPLE_MODEL);
    });
  });

  describe('modelId legado/inválido', () => {
    it('cai no Sakana (comportamento anterior) para modelo Anthropic legado', () => {
      const model = service.selectModel(
        input({ modelId: 'claude-sonnet-4-6', agentKind: 'WORKER', phase: 'synthesis' }),
      );
      expect(model).toBe(SAKANA_CONVERSATION_MODEL);
    });

    it('ignora override de routing com modelo não suportado', () => {
      const model = service.selectModel(
        input({
          modelId: 'openai/gpt-4o',
          phase: 'tool',
          modelParams: { routing: { primary: 'google/gemini-2.0' } },
        }),
      );
      expect(model).toBe(OPENAI_SIMPLE_MODEL);
    });
  });
});
