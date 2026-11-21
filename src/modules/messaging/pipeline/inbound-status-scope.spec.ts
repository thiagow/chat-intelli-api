import { InboundMessageProcessor } from './inbound-message.processor';

/**
 * processStatus precisa escopar a busca da Message ao canal/org do webhook:
 * external ids são do provider e um ack de um canal não pode tocar a
 * mensagem de outro tenant.
 */
function build(found: any) {
  const prisma = {
    message: {
      findFirst: jest.fn().mockResolvedValue(found),
      update: jest.fn().mockImplementation(async ({ data }) => ({ ...found, ...data })),
    },
  };
  const realtime = { emitToConversation: jest.fn() };
  const webhookEvents = { markProcessed: jest.fn() };
  const processor = new InboundMessageProcessor(
    prisma as any,
    {} as any,
    {} as any,
    {} as any,
    realtime as any,
    {} as any,
    {} as any,
    {} as any,
    webhookEvents as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { applyStatus: jest.fn().mockResolvedValue(false) } as any,
    {} as any,
  );
  return { processor, prisma, realtime };
}

const status = (id: string) => ({
  externalMessageId: id,
  status: 'delivered' as const,
  timestamp: new Date(),
});

describe('InboundMessageProcessor.processStatus — escopo', () => {
  it('filtra por canal e organização', async () => {
    const { processor, prisma } = build({
      id: 'm1',
      conversationId: 'c1',
      status: 'SENT',
      sentAt: new Date(),
    });
    await (processor as any).processStatus({
      channelId: 'ch1',
      organizationId: 'org1',
      status: status('X1'),
    });
    expect(prisma.message.findFirst).toHaveBeenCalledWith({
      where: {
        externalId: 'X1',
        conversation: { channelId: 'ch1', organizationId: 'org1' },
      },
    });
  });

  it('não atualiza nada quando a mensagem é de outro canal (não encontrada no escopo)', async () => {
    const { processor, prisma, realtime } = build(null);
    await (processor as any).processStatus({
      channelId: 'ch-outro',
      organizationId: 'org1',
      status: status('X1'),
    });
    expect(prisma.message.update).not.toHaveBeenCalled();
    expect(realtime.emitToConversation).not.toHaveBeenCalled();
  });

  it('sem organizationId, ainda escopa pelo canal', async () => {
    const { processor, prisma } = build(null);
    await (processor as any).processStatus({ channelId: 'ch1', status: status('X1') });
    expect(prisma.message.findFirst).toHaveBeenCalledWith({
      where: { externalId: 'X1', conversation: { channelId: 'ch1' } },
    });
  });
});
