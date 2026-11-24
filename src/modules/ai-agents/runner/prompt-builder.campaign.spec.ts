import { PromptBuilderService } from './prompt-builder.service';

function ctx(conversationMetadata: Record<string, unknown>): any {
  return {
    organization: { name: 'Org', aiTimezone: 'America/Sao_Paulo', aiBusinessNotes: null },
    agent: { name: 'Ana', systemPrompt: 'Seja gentil.', operationalContext: null },
    channel: { name: 'Comercial', type: 'WHATSAPP_UAZAPI' },
    contact: { name: 'Padaria Central', phone: '5562999990000', email: null },
    conversation: { id: 'c1', metadata: conversationMetadata },
    recentMessages: [],
    memorySummary: null,
    memoryFacts: null,
    triggerMessage: { id: 'm1', content: { text: 'Quero saber mais' }, direction: 'INBOUND', type: 'TEXT', createdAt: new Date() },
  };
}

function systemText(builder: PromptBuilderService, c: any): string {
  const msgs = builder.buildMessages(c) as any[];
  const sys = msgs.find((m) => m.role === 'system');
  return (Array.isArray(sys.content) ? sys.content.map((p: any) => p.text ?? '').join('\n') : String(sys.content));
}

describe('PromptBuilderService — contexto da campanha de prospecção', () => {
  const builder = new PromptBuilderService();

  it('sem metadata.campaign o bloco não aparece', () => {
    expect(systemText(builder, ctx({}))).not.toContain('Contexto da campanha de prospecção');
  });

  it('com contexto da operação injeta nome, mensagem enviada e instruções (sem escapar aspas)', () => {
    const t = systemText(
      builder,
      ctx({
        campaign: {
          id: 'cmp1',
          name: 'Black "Friday"',
          sentText: 'Olá, equipe da Padaria! Temos uma oferta.',
          aiContext: 'Ofereça uma demo de 15 min. Não fale de preço antes.',
        },
      }),
    );
    expect(t).toContain('Contexto da campanha de prospecção');
    expect(t).toContain('Black "Friday"');
    expect(t).toContain('Olá, equipe da Padaria! Temos uma oferta.');
    expect(t).toContain('Ofereça uma demo de 15 min.');
  });

  it('sem aiContext (só id) o bloco não aparece', () => {
    expect(systemText(builder, ctx({ campaign: { id: 'cmp1', name: 'X' } }))).not.toContain('Contexto da campanha de prospecção');
  });

  it('metadata ausente ou nula não quebra o prompt', () => {
    const c = ctx({});
    c.conversation.metadata = null;
    expect(() => builder.buildMessages(c)).not.toThrow();
  });
});
