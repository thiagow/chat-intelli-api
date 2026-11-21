import { CampaignTrackingService } from './campaign-tracking.service';

function build(overrides: Record<string, any> = {}) {
  const prisma: any = {
    message: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'msg1' }) },
    campaignRecipient: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    },
    conversation: { update: jest.fn().mockResolvedValue({}) },
    contact: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    ...overrides,
  };
  const realtime: any = { emitToOrg: jest.fn() };
  return { svc: new CampaignTrackingService(prisma, realtime), prisma, realtime };
}

const echo = (text: string | null, extra: Record<string, any> = {}) => ({
  organizationId: 'org1',
  channelId: 'ch1',
  contactId: 'ct1',
  externalMessageId: 'WA1',
  text,
  ...extra,
});

const recipient = (over: Record<string, any> = {}) => ({
  id: 'r1',
  campaignId: 'cmp1',
  status: 'QUEUED',
  renderedText: 'Oi Acme!\n\nResponda SAIR',
  providerMessageId: null,
  sentAt: null,
  deliveredAt: null,
  readAt: null,
  messageId: null,
  ...over,
});

describe('CampaignTrackingService.tryConsumeEcho', () => {
  it('consome o echo quando contato + texto renderizado batem (grava SENT e providerMessageId)', async () => {
    const { svc, prisma } = build();
    prisma.campaignRecipient.findMany.mockResolvedValue([recipient()]);
    expect(await svc.tryConsumeEcho(echo('Oi  Acme!\nResponda SAIR'))).toBe(true);
    expect(prisma.campaignRecipient.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: expect.objectContaining({ providerMessageId: 'WA1', status: 'SENT' }),
    });
  });

  it('NÃO engole mensagem manual do mesmo contato com outro texto', async () => {
    const { svc, prisma } = build();
    prisma.campaignRecipient.findMany.mockResolvedValue([recipient()]);
    expect(await svc.tryConsumeEcho(echo('Tudo bem? Aqui é o atendente'))).toBe(false);
    expect(prisma.campaignRecipient.update).not.toHaveBeenCalled();
  });

  it('mensagem já existente pelo externalId (enviada pela plataforma) segue o fluxo normal', async () => {
    const { svc, prisma } = build();
    prisma.message.findFirst.mockResolvedValue({ id: 'm1' });
    prisma.campaignRecipient.findMany.mockResolvedValue([recipient()]);
    expect(await svc.tryConsumeEcho(echo('Oi Acme!\n\nResponda SAIR'))).toBe(false);
  });

  it('sem texto (mídia) nunca consome', async () => {
    const { svc } = build();
    expect(await svc.tryConsumeEcho(echo(null))).toBe(false);
  });

  it('restringe a busca a recipients da org/canal/contato e a lotes ativos', async () => {
    const { svc, prisma } = build();
    await svc.tryConsumeEcho(echo('x'));
    const where = prisma.campaignRecipient.findMany.mock.calls[0][0].where;
    expect(where.organizationId).toBe('org1');
    expect(where.contactId).toBe('ct1');
    expect(where.campaign).toEqual({ channelId: 'ch1', deletedAt: null });
  });
});

describe('CampaignTrackingService.onInbound', () => {
  const input = (text: string | null, fresh = true) => ({
    organizationId: 'org1',
    channelId: 'ch1',
    contactId: 'ct1',
    conversationId: 'conv1',
    conversationIsFresh: fresh,
    text,
  });
  const sent = (over: Record<string, any> = {}) => ({
    ...recipient({ status: 'DELIVERED', sentAt: new Date(Date.now() - 3600_000), providerMessageId: 'WA1' }),
    campaign: { id: 'cmp1', replyRouting: 'AI', replyWindowDays: 7 },
    ...over,
  });

  it('resposta: insere a mensagem da campanha, aplica roteamento e marca respondida', async () => {
    const { svc, prisma } = build();
    prisma.campaignRecipient.findMany.mockResolvedValue([sent()]);
    await svc.onInbound(input('Tenho interesse'));
    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          direction: 'OUTBOUND',
          externalId: 'WA1',
          metadata: { source: 'campaign', campaignId: 'cmp1' },
        }),
      }),
    );
    expect(prisma.conversation.update).toHaveBeenCalledWith({ where: { id: 'conv1' }, data: { aiEnabled: true } });
    expect(prisma.campaignRecipient.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: expect.objectContaining({ conversationId: 'conv1', messageId: 'msg1', repliedAt: expect.any(Date) }),
    });
  });

  it('roteamento HUMAN desliga a IA; CHANNEL_DEFAULT não toca; conversa existente não é re-roteada', async () => {
    const a = build();
    a.prisma.campaignRecipient.findMany.mockResolvedValue([sent({ campaign: { id: 'c', replyRouting: 'HUMAN', replyWindowDays: 7 } })]);
    await a.svc.onInbound(input('oi'));
    expect(a.prisma.conversation.update).toHaveBeenCalledWith({ where: { id: 'conv1' }, data: { aiEnabled: false } });

    const b = build();
    b.prisma.campaignRecipient.findMany.mockResolvedValue([sent({ campaign: { id: 'c', replyRouting: 'CHANNEL_DEFAULT', replyWindowDays: 7 } })]);
    await b.svc.onInbound(input('oi'));
    expect(b.prisma.conversation.update).not.toHaveBeenCalled();

    const c = build();
    c.prisma.campaignRecipient.findMany.mockResolvedValue([sent()]);
    await c.svc.onInbound(input('oi', false));
    expect(c.prisma.conversation.update).not.toHaveBeenCalled();
  });

  it('fora da janela de resposta não vincula', async () => {
    const { svc, prisma } = build();
    prisma.campaignRecipient.findMany.mockResolvedValue([sent({ sentAt: new Date(Date.now() - 10 * 86_400_000) })]);
    await svc.onInbound(input('oi'));
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it('opt-out exato grava marketingOptOutAt e emite evento; frase longa não', async () => {
    const a = build();
    a.prisma.campaignRecipient.findFirst.mockResolvedValue({ campaignId: 'cmp1' });
    await a.svc.onInbound(input('SAIR'));
    expect(a.prisma.contact.updateMany).toHaveBeenCalledWith({
      where: { id: 'ct1', organizationId: 'org1', marketingOptOutAt: null },
      data: expect.objectContaining({ marketingOptOutAt: expect.any(Date), marketingOptOutSource: 'campaign:cmp1' }),
    });
    expect(a.realtime.emitToOrg).toHaveBeenCalledWith('org1', 'contact:opted-out', expect.any(Object));

    const b = build();
    await b.svc.onInbound(input('quero sair do plano premium'));
    expect(b.prisma.contact.updateMany).not.toHaveBeenCalled();
  });

  it('opt-out só vale para quem recebeu campanha', async () => {
    const { svc, prisma } = build();
    prisma.campaignRecipient.findFirst.mockResolvedValue(null);
    await svc.onInbound(input('PARAR'));
    expect(prisma.contact.updateMany).not.toHaveBeenCalled();
  });

  it('erro no rastreio nunca derruba o inbound', async () => {
    const { svc, prisma } = build();
    prisma.campaignRecipient.findMany.mockRejectedValue(new Error('db down'));
    await expect(svc.onInbound(input('oi'))).resolves.toBeUndefined();
  });
});

describe('CampaignTrackingService.applyStatus', () => {
  it('escopa por canal/org e nunca regride (READ não volta para DELIVERED)', async () => {
    const { svc, prisma } = build();
    prisma.campaignRecipient.findFirst.mockResolvedValue(recipient({ status: 'READ', readAt: new Date(), deliveredAt: new Date(), sentAt: new Date() }));
    await svc.applyStatus({ channelId: 'ch1', organizationId: 'org1', providerMessageId: 'WA1', status: 'DELIVERED' as any });
    expect(prisma.campaignRecipient.findFirst.mock.calls[0][0].where).toEqual({
      providerMessageId: 'WA1',
      campaign: { channelId: 'ch1' },
      organizationId: 'org1',
    });
    expect(prisma.campaignRecipient.update).not.toHaveBeenCalled();
  });

  it('avança QUEUED → DELIVERED preenchendo sentAt', async () => {
    const { svc, prisma } = build();
    prisma.campaignRecipient.findFirst.mockResolvedValue(recipient());
    await svc.applyStatus({ channelId: 'ch1', providerMessageId: 'WA1', status: 'DELIVERED' as any });
    expect(prisma.campaignRecipient.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: expect.objectContaining({ status: 'DELIVERED', deliveredAt: expect.any(Date), sentAt: expect.any(Date) }),
    });
  });

  it('id desconhecido não faz nada', async () => {
    const { svc } = build();
    expect(await svc.applyStatus({ channelId: 'ch1', providerMessageId: 'X', status: 'READ' as any })).toBe(false);
  });
});
