import { CampaignsEngine } from './campaigns.engine';

function build(opts: { folders?: any[]; createFolder?: jest.Mock; recipients?: any[]; optedOutPhones?: string[] } = {}) {
  const campaign = {
    id: 'cmp1',
    organizationId: 'org1',
    channelId: 'ch1',
    status: 'SUBMITTING',
    delayMinSec: 30,
    delayMaxSec: 90,
    dailyCap: 200,
    batchSize: 20,
    batchPauseMinSec: 300,
    batchPauseMaxSec: 300,
    sendWindowStart: '00:00',
    sendWindowEnd: '23:59',
    sendWeekdays: [0, 1, 2, 3, 4, 5, 6],
    maxFailureRatePct: 15,
    appendOptOutFooter: true,
    channel: { id: 'ch1', type: 'WHATSAPP_UAZAPI' },
    organization: { aiTimezone: 'America/Sao_Paulo' },
  };
  const batch = { id: 'b1', campaignId: 'cmp1', batchIndex: 0, status: 'PLANNED', providerFolderId: null, scheduledFor: new Date() };
  const recipients = opts.recipients ?? [
    { id: 'r1', phoneE164: '5511999998888', jid: '5511999998888@s.whatsapp.net', companyName: 'Acme', messageText: 'Oi {{empresa}}', rowNumber: 2 },
    { id: 'r2', phoneE164: '5511988887777', jid: '5511988887777@s.whatsapp.net', companyName: 'Beta', messageText: 'Olá', rowNumber: 3 },
  ];

  const prisma: any = {
    campaign: {
      findFirst: jest.fn().mockResolvedValue(campaign),
      findUnique: jest.fn().mockResolvedValue({ status: campaign.status }),
      update: jest.fn().mockResolvedValue({ id: 'cmp1', organizationId: 'org1', status: 'SCHEDULED', autoPausedReason: null }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    campaignBatch: {
      findUnique: jest.fn().mockResolvedValue(batch),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(1),
    },
    campaignRecipient: {
      findMany: jest.fn().mockResolvedValue(recipients),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      groupBy: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    contact: {
      findMany: jest.fn().mockResolvedValue((opts.optedOutPhones ?? []).map((p) => ({ phone: p }))),
    },
    contactChannel: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn().mockImplementation(async (arg: any) => (Array.isArray(arg) ? Promise.all(arg) : arg(prisma))),
  };
  const createFolder = opts.createFolder ?? jest.fn().mockResolvedValue({ folderId: 'F-new' });
  const bulk: any = {
    listFolders: jest.fn().mockResolvedValue(opts.folders ?? []),
    createFolder,
    controlFolder: jest.fn(),
    isConnected: jest.fn().mockResolvedValue(true),
    listFolderMessages: jest.fn().mockResolvedValue({ messages: [], hasMore: false }),
  };
  const registry: any = { getBulkSender: jest.fn().mockReturnValue(bulk) };
  const realtime: any = { emitToOrg: jest.fn() };
  const provisioning: any = {
    provision: jest.fn().mockImplementation(async (_o: string, _c: string, _t: string, d: any) => ({
      contactId: `ct-${d.phone}`,
      externalId: d.externalId,
    })),
  };
  const queue: any = { add: jest.fn().mockResolvedValue({}), remove: jest.fn() };
  const engine = new CampaignsEngine(prisma, registry, realtime, provisioning, queue);
  return { engine, prisma, bulk, queue, provisioning, realtime, createFolder };
}

describe('CampaignsEngine.submitBatch', () => {
  it('cria a pasta com info idempotente, texto renderizado e número do JID verificado', async () => {
    const { engine, createFolder, prisma } = build();
    const out = await engine.submitBatch('cmp1', 'b1');
    expect(out.folderId).toBe('F-new');
    const input = createFolder.mock.calls[0][1];
    expect(input.info).toBe('ic:cmp1:0');
    expect(input.messages[0]).toEqual({
      number: '5511999998888',
      text: expect.stringContaining('Oi Acme'),
    });
    expect(input.messages[0].text).toContain('Responda SAIR');
    // renderedText foi persistido antes de chamar o provider
    const persistedBeforeCreate = prisma.campaignRecipient.update.mock.invocationCallOrder[0] < createFolder.mock.invocationCallOrder[0];
    expect(persistedBeforeCreate).toBe(true);
  });

  it('retry depois de timeout NÃO duplica: reaproveita a pasta já existente pelo info', async () => {
    const { engine, createFolder, prisma } = build({ folders: [{ folderId: 'F-old', info: 'ic:cmp1:0' }] });
    const out = await engine.submitBatch('cmp1', 'b1');
    expect(out.folderId).toBe('F-old');
    expect(createFolder).not.toHaveBeenCalled();
    expect(prisma.campaignBatch.updateMany).toHaveBeenCalledWith({
      where: { id: 'b1', status: 'SUBMITTING' },
      data: expect.objectContaining({ providerFolderId: 'F-old', status: 'SCHEDULED' }),
    });
  });

  it('reaproveita providerFolderId já gravado no lote sem nem listar', async () => {
    const { engine, createFolder, bulk, prisma } = build();
    prisma.campaignBatch.findUnique.mockResolvedValue({
      id: 'b1', campaignId: 'cmp1', batchIndex: 0, status: 'SUBMITTING', providerFolderId: 'F-saved', scheduledFor: new Date(),
    });
    await engine.submitBatch('cmp1', 'b1');
    expect(bulk.listFolders).not.toHaveBeenCalled();
    expect(createFolder).not.toHaveBeenCalled();
  });

  it('recheck de opt-out: quem optou fora desde o import não vai para a pasta', async () => {
    const { engine, createFolder, prisma } = build({ optedOutPhones: ['5511999998888'] });
    await engine.submitBatch('cmp1', 'b1');
    expect(prisma.campaignRecipient.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['r1'] } },
      data: { status: 'OPTED_OUT' },
    });
    const numbers = createFolder.mock.calls[0][1].messages.map((m: any) => m.number);
    expect(numbers).toEqual(['5511988887777']);
  });

  it('campanha pausada/cancelada: não submete', async () => {
    const { engine, createFolder, prisma } = build();
    prisma.campaign.findFirst.mockResolvedValue({ ...(await prisma.campaign.findFirst()), status: 'PAUSED' });
    const out = await engine.submitBatch('cmp1', 'b1');
    expect(out.skipped).toBe('campaign_not_active');
    expect(createFolder).not.toHaveBeenCalled();
  });

  it('lote anterior ainda ativo: reagenda em vez de submeter', async () => {
    const { engine, createFolder, prisma, queue } = build();
    prisma.campaignBatch.findUnique.mockResolvedValue({
      id: 'b2', campaignId: 'cmp1', batchIndex: 1, status: 'PLANNED', providerFolderId: null, scheduledFor: new Date(),
    });
    prisma.campaignBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'RUNNING', completedAt: null });
    const out = await engine.submitBatch('cmp1', 'b2');
    expect(out.skipped).toBe('previous_batch_active');
    expect(queue.add).toHaveBeenCalledWith(
      'submit-batch',
      { campaignId: 'cmp1', batchId: 'b2' },
      expect.objectContaining({ delay: 60_000 }),
    );
    expect(createFolder).not.toHaveBeenCalled();
  });

  it('lote seguinte só começa depois da pausa contada a partir do término REAL do anterior', async () => {
    const { engine, createFolder, prisma } = build();
    prisma.campaignBatch.findUnique.mockResolvedValue({
      id: 'b2', campaignId: 'cmp1', batchIndex: 1, status: 'PLANNED', providerFolderId: null, scheduledFor: new Date(),
    });
    // O anterior terminou agora: a pausa de 300s (min = max) ainda vale.
    prisma.campaignBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'DONE', completedAt: new Date() });
    const before = Date.now();
    await engine.submitBatch('cmp1', 'b2');
    expect(createFolder).toHaveBeenCalledTimes(1);
    const { scheduledFor } = createFolder.mock.calls[0][1];
    expect(scheduledFor).toBeGreaterThanOrEqual(before + 299_000);
  });

  it('lote anterior terminou há muito tempo: a pausa não atrasa o próximo', async () => {
    const { engine, createFolder, prisma } = build();
    prisma.campaignBatch.findUnique.mockResolvedValue({
      id: 'b2', campaignId: 'cmp1', batchIndex: 1, status: 'PLANNED', providerFolderId: null, scheduledFor: new Date(),
    });
    prisma.campaignBatch.findFirst.mockResolvedValue({ id: 'b1', status: 'DONE', completedAt: new Date(Date.now() - 3_600_000) });
    const before = Date.now();
    await engine.submitBatch('cmp1', 'b2');
    const { scheduledFor } = createFolder.mock.calls[0][1];
    expect(scheduledFor).toBeLessThan(before + 60_000);
  });

  it('pausa/cancelamento DURANTE a submissão: a pasta recém-criada é parada, não fica viva', async () => {
    const { engine, bulk, prisma } = build();
    prisma.campaign.findUnique.mockResolvedValue({ status: 'PAUSED' });
    const out = await engine.submitBatch('cmp1', 'b1');
    expect(out.skipped).toBe('stopped_during_submit');
    expect(bulk.controlFolder).toHaveBeenCalledWith(expect.anything(), 'F-new', 'stop');
  });

  it('cancelado durante a submissão (lote já não está SUBMITTING): para a pasta e guarda o folderId', async () => {
    const { engine, bulk, prisma } = build();
    prisma.campaignBatch.updateMany.mockResolvedValueOnce({ count: 0 });
    const out = await engine.submitBatch('cmp1', 'b1');
    expect(out.skipped).toBe('stopped_during_submit');
    expect(bulk.controlFolder).toHaveBeenCalledWith(expect.anything(), 'F-new', 'stop');
  });

  it('lote vazio (todos opt-out) fecha como DONE sem chamar o provider', async () => {
    const { engine, createFolder, prisma } = build({ optedOutPhones: ['5511999998888', '5511988887777'] });
    const out = await engine.submitBatch('cmp1', 'b1');
    expect(out.skipped).toBe('empty_batch');
    expect(createFolder).not.toHaveBeenCalled();
    expect(prisma.campaignBatch.update).toHaveBeenCalledWith({
      where: { id: 'b1' },
      data: expect.objectContaining({ status: 'DONE' }),
    });
  });
});

describe('CampaignsEngine.reconcileCampaign — pausa automática', () => {
  function reconcileSetup(stats: { sent: number; failed: number }, maxPct = 15) {
    const ctx = build();
    ctx.prisma.campaign.findFirst.mockResolvedValue({
      id: 'cmp1', organizationId: 'org1', channelId: 'ch1', status: 'RUNNING', maxFailureRatePct: maxPct,
      channel: { id: 'ch1', type: 'WHATSAPP_UAZAPI' }, organization: { aiTimezone: 'America/Sao_Paulo' },
    });
    ctx.prisma.campaignBatch.findMany.mockResolvedValue([]);
    ctx.prisma.campaignRecipient.groupBy.mockResolvedValue([
      { status: 'SENT', _count: { _all: stats.sent } },
      { status: 'FAILED', _count: { _all: stats.failed } },
    ]);
    return ctx;
  }

  it('taxa de falha acima do limite com amostra mínima pausa e registra o motivo', async () => {
    const { engine, prisma, realtime } = reconcileSetup({ sent: 20, failed: 20 });
    await engine.reconcileCampaign('cmp1');
    expect(prisma.campaign.updateMany).toHaveBeenCalledWith({
      where: { id: 'cmp1', status: { in: ['SUBMITTING', 'SCHEDULED', 'RUNNING'] } },
      data: { status: 'PAUSED', autoPausedReason: 'FAILURE_RATE' },
    });
    expect(realtime.emitToOrg).toHaveBeenCalledWith('org1', 'campaign:auto-paused', { campaignId: 'cmp1', reason: 'FAILURE_RATE' });
  });

  it('amostra abaixo do mínimo não pausa mesmo com 100% de falha', async () => {
    const { engine, realtime } = reconcileSetup({ sent: 0, failed: 10 });
    await engine.reconcileCampaign('cmp1');
    expect(realtime.emitToOrg).not.toHaveBeenCalledWith('org1', 'campaign:auto-paused', expect.anything());
  });

  it('taxa dentro do limite não pausa', async () => {
    const { engine, realtime } = reconcileSetup({ sent: 95, failed: 5 });
    await engine.reconcileCampaign('cmp1');
    expect(realtime.emitToOrg).not.toHaveBeenCalledWith('org1', 'campaign:auto-paused', expect.anything());
  });

  it('canal desconectado pausa com CHANNEL_DISCONNECTED', async () => {
    const { engine, bulk, prisma } = reconcileSetup({ sent: 1, failed: 0 });
    bulk.isConnected.mockResolvedValue(false);
    await engine.reconcileCampaign('cmp1');
    expect(prisma.campaign.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'PAUSED', autoPausedReason: 'CHANNEL_DISCONNECTED' } }),
    );
  });
});

describe('CampaignsEngine.computeStats', () => {
  it('contadores cumulativos (entregue implica enviado) vindos de groupBy', async () => {
    const { engine, prisma } = build();
    prisma.campaignRecipient.groupBy.mockResolvedValue([
      { status: 'SENT', _count: { _all: 2 } },
      { status: 'DELIVERED', _count: { _all: 3 } },
      { status: 'READ', _count: { _all: 1 } },
      { status: 'FAILED', _count: { _all: 1 } },
      { status: 'INVALID', _count: { _all: 4 } },
    ]);
    prisma.campaignRecipient.count.mockResolvedValue(2);
    expect(await engine.computeStats('cmp1')).toMatchObject({
      total: 11, sent: 6, delivered: 4, read: 1, failed: 1, invalid: 4, replied: 2,
    });
  });
});

describe('CampaignsEngine.finalizeBatch', () => {
  it('cria o lote de sobra ANTES de marcar o lote como DONE (sem COMPLETED prematuro)', async () => {
    const { engine, prisma, bulk } = build();
    const order: string[] = [];
    prisma.campaign.findFirst.mockResolvedValue({
      id: 'cmp1', organizationId: 'org1', channelId: 'ch1', status: 'RUNNING', dailyCap: 200,
      sendWindowStart: '00:00', sendWindowEnd: '23:59', sendWeekdays: [0,1,2,3,4,5,6], delayMinSec: 30, delayMaxSec: 90,
      maxFailureRatePct: 15, channel: { id: 'ch1', type: 'WHATSAPP_UAZAPI' }, organization: { aiTimezone: 'America/Sao_Paulo' },
    });
    prisma.campaignBatch.findUnique.mockResolvedValue({ id: 'b1', campaignId: 'cmp1', status: 'RUNNING', providerFolderId: 'F1' });
    prisma.campaignBatch.findMany.mockResolvedValue([]);
    prisma.campaignRecipient.findMany.mockImplementation(async (a: any) =>
      a.where?.status === 'QUEUED' ? [{ id: 'left1' }] : [],
    );
    prisma.campaignBatch.findFirst.mockResolvedValue({ id: 'b2', batchIndex: 1, status: 'PLANNED' });
    prisma.campaignBatch.update.mockImplementation(async (a: any) => {
      order.push(a.data.status ? 'batch:' + a.data.status : a.data.recipientCount ? 'carry' : 'other');
      return {};
    });
    await engine.finalizeBatch('cmp1', 'b1');
    expect(bulk.controlFolder).toHaveBeenCalledWith(expect.anything(), 'F1', 'stop');
    expect(order.indexOf('carry')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('carry')).toBeLessThan(order.indexOf('batch:DONE'));
  });
});
