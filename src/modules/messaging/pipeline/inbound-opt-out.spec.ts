import { ConversationStatus } from '@prisma/client';
import { InboundMessageProcessor } from './inbound-message.processor';

/**
 * Resposta negativa a uma campanha ("parar", "não tenho interesse", "tirar da lista"): o fluxo ENCERRA sem
 * responder. Nenhum caminho automático (IA, chatbot, automação, watchdog) pode ser acionado, e a conversa é
 * encerrada pela FSM.
 */
function build(outcome: { optedOut: boolean }, status: ConversationStatus = ConversationStatus.PENDING) {
  const tx = { $executeRaw: jest.fn().mockResolvedValue(1) };
  const prisma: any = {
    $transaction: jest.fn().mockImplementation(async (fn: any) => fn(tx)),
    conversation: { update: jest.fn().mockResolvedValue({}) },
    channel: { findUnique: jest.fn().mockResolvedValue(null) },
    contact: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const idempotency = { claimProcessing: jest.fn().mockResolvedValue(true), markProcessed: jest.fn() };
  const contactResolver = { resolve: jest.fn().mockResolvedValue({ contactId: 'ct1', isNew: false }) };
  const conversationResolver = {
    resolve: jest.fn().mockResolvedValue({ conversationId: 'conv1', status, isNew: true, wasReopened: false }),
  };
  const realtime = { emitToChannel: jest.fn(), emitToConversation: jest.fn(), emitToOrg: jest.fn() };
  const webhookEvents = { markProcessed: jest.fn(), markFailed: jest.fn() };
  const agentRouter = { shouldHandle: jest.fn() };
  const agentRunner = { run: jest.fn() };
  const outbox = { enqueue: jest.fn() };
  const watchdog = { scheduleCheck: jest.fn().mockResolvedValue(undefined), cancelCheck: jest.fn().mockResolvedValue(undefined) };
  const salesRecovery = { onInboundReply: jest.fn().mockResolvedValue(undefined) };
  const campaignTracking = {
    tryConsumeEcho: jest.fn().mockResolvedValue(false),
    onInbound: jest.fn().mockResolvedValue(outcome),
  };
  const chatbotQueue = { add: jest.fn() };
  const fsm = { transition: jest.fn().mockResolvedValue(undefined) };

  const processor = new InboundMessageProcessor(
    prisma, idempotency as any, contactResolver as any, conversationResolver as any, realtime as any,
    {} as any, {} as any, {} as any, webhookEvents as any, agentRouter as any, agentRunner as any,
    { transcribe: jest.fn() } as any, outbox as any, watchdog as any, salesRecovery as any,
    campaignTracking as any, chatbotQueue as any, fsm as any,
  );
  // O upsert real é pesado; aqui só interessa o que vem depois dele.
  jest.spyOn(processor as any, 'upsertMessage').mockResolvedValue({ message: { id: 'm1', type: 'TEXT' }, isNew: true });
  const tryAi = jest.spyOn(processor as any, 'tryAiAgent').mockResolvedValue(undefined);
  jest.spyOn(processor as any, 'checkActiveBotForChannel').mockResolvedValue(true); // há bot ativo no canal

  const job: any = {
    name: 'process-message',
    data: {
      channelId: 'ch1',
      organizationId: 'org1',
      message: {
        externalMessageId: 'WA9',
        externalContactId: '5562999990000@s.whatsapp.net',
        channelType: 'WHATSAPP_UAZAPI',
        type: 'TEXT',
        isEcho: false,
        content: { text: 'não tenho interesse' },
        timestamp: new Date().toISOString(),
      },
    },
  };
  return { processor, job, outbox, watchdog, salesRecovery, chatbotQueue, fsm, tryAi, campaignTracking };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('InboundMessageProcessor — opt-out por resposta a campanha', () => {
  it('optedOut: não aciona IA, chatbot, automação nem watchdog e encerra a conversa pela FSM', async () => {
    const { processor, job, outbox, watchdog, salesRecovery, chatbotQueue, fsm, tryAi } = build({ optedOut: true });
    await processor.process(job);
    await flush();

    expect(outbox.enqueue).not.toHaveBeenCalled(); // nenhuma automação "mensagem recebida" para responder
    expect(chatbotQueue.add).not.toHaveBeenCalled(); // chatbot não responde
    expect(tryAi).not.toHaveBeenCalled(); // IA não responde
    expect(watchdog.scheduleCheck).not.toHaveBeenCalled(); // sem timer de "ninguém respondeu"
    expect(salesRecovery.onInboundReply).not.toHaveBeenCalled();
    expect(fsm.transition).toHaveBeenCalledWith('conv1', ConversationStatus.CLOSED, undefined, { reason: 'campaign_opt_out' });
  });

  it('mensagem normal (sem opt-out): fluxo de sempre — automação, chatbot, watchdog e IA são acionados', async () => {
    const { processor, job, outbox, watchdog, chatbotQueue, fsm, tryAi } = build({ optedOut: false });
    await processor.process(job);
    await flush();

    expect(outbox.enqueue).toHaveBeenCalled();
    expect(chatbotQueue.add).toHaveBeenCalled();
    expect(watchdog.scheduleCheck).toHaveBeenCalledWith('conv1');
    expect(tryAi).toHaveBeenCalled();
    expect(fsm.transition).not.toHaveBeenCalled();
  });

  it('se a FSM recusar o encerramento (transição inválida), o fluxo não quebra e continua sem responder', async () => {
    const { processor, job, fsm, tryAi, chatbotQueue } = build({ optedOut: true });
    fsm.transition.mockRejectedValue(new Error('Invalid transition: BOT → CLOSED'));
    await expect(processor.process(job)).resolves.toBeDefined();
    await flush();
    expect(tryAi).not.toHaveBeenCalled();
    expect(chatbotQueue.add).not.toHaveBeenCalled();
  });

  it('echo (mensagem nossa) nunca passa pelo hook de resposta nem encerra conversa', async () => {
    const { processor, job, campaignTracking, fsm } = build({ optedOut: true });
    job.data.message.isEcho = true;
    await processor.process(job);
    await flush();
    expect(campaignTracking.onInbound).not.toHaveBeenCalled();
    expect(fsm.transition).not.toHaveBeenCalled();
  });
});
