import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CampaignsService, maskCampaign } from './campaigns.service';

function build() {
  const campaign = {
    id: 'cmp1', organizationId: 'org1', channelId: 'ch1', status: 'READY',
    dailyCap: 200, sendWindowStart: '09:00', sendWindowEnd: '18:00', sendWeekdays: [0, 1, 2, 3, 4, 5, 6],
    delayMinSec: 30, delayMaxSec: 90, scheduledAt: null,
  };
  const prisma: any = {
    campaign: { findFirst: jest.fn().mockResolvedValue(campaign) },
    channel: { findFirst: jest.fn().mockResolvedValue({ id: 'ch1', type: 'WHATSAPP_UAZAPI' }) },
    organization: { findUnique: jest.fn().mockResolvedValue({ aiTimezone: 'America/Sao_Paulo' }) },
    campaignRecipient: { findMany: jest.fn().mockResolvedValue([{ id: 'r1' }]), groupBy: jest.fn().mockResolvedValue([]) },
    campaignChannel: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: jest.fn(),
  };
  const bulk: any = { isConnected: jest.fn().mockResolvedValue(true), ensureWebhook: jest.fn() };
  const engine: any = {
    bulkFor: jest.fn().mockReturnValue(bulk),
    scheduleSubmit: jest.fn(),
    scheduleReconcile: jest.fn(),
    emitProgress: jest.fn(),
    findOptedOut: jest.fn().mockResolvedValue(new Set()),
  };
  const access: any = { assertChannelAccess: jest.fn(), hasAccess: jest.fn().mockReturnValue(true) };
  const registry: any = { hasBulkSender: jest.fn().mockReturnValue(true) };
  const config: any = { get: jest.fn((k: string, d?: string) => (k === 'APP_URL' ? undefined : d)) };
  const queue: any = { add: jest.fn() };
  const replyWebhook: any = { sendTest: jest.fn().mockResolvedValue({ ok: true, status: 200 }) };
  const svc = new CampaignsService(prisma, registry, access, engine, config, queue, replyWebhook);
  return { svc, prisma, engine, config, registry, replyWebhook };
}

describe('CampaignsService', () => {
  it('start: segunda campanha ativa no mesmo canal (P2002 do índice parcial) vira 409 legível', async () => {
    const { svc, prisma } = build();
    prisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'x' }),
    );
    await expect(svc.start('org1', 'cmp1', 'ALL')).rejects.toThrow(ConflictException);
    await expect(svc.start('org1', 'cmp1', 'ALL')).rejects.toThrow(/campanha ativa/i);
  });

  it('start: só inicia campanha READY', async () => {
    const { svc, prisma } = build();
    prisma.campaign.findFirst.mockResolvedValue({ id: 'cmp1', organizationId: 'org1', channelId: 'ch1', status: 'DRAFT' });
    await expect(svc.start('org1', 'cmp1', 'ALL')).rejects.toThrow(ConflictException);
  });

  it('start: canal desconectado bloqueia', async () => {
    const { svc, engine } = build();
    engine.bulkFor().isConnected.mockResolvedValue(false);
    await expect(svc.start('org1', 'cmp1', 'ALL')).rejects.toThrow(/desconectado/);
  });

  it('kill switch CAMPAIGNS_ENABLED=false bloqueia import e start', async () => {
    const { svc, config } = build();
    config.get.mockImplementation((k: string) => (k === 'CAMPAIGNS_ENABLED' ? 'false' : undefined));
    await expect(svc.start('org1', 'cmp1', 'ALL')).rejects.toThrow(/desativadas/);
    await expect(svc.import('org1', 'u1', 'ALL', {} as any, undefined)).rejects.toThrow(/desativadas/);
  });

  it('import: origem OUTRO exige descrição (422); sem arquivo é 400', async () => {
    const { svc } = build();
    const dto: any = { channelId: 'ch1', name: 'Teste', consentSource: 'OUTRO' };
    const file = { buffer: Buffer.from('whatsapp,empresa,mensagem\n11999998888,A,Oi') };
    await expect(svc.import('org1', 'u1', 'ALL', dto, file)).rejects.toThrow(UnprocessableEntityException);
    await expect(svc.import('org1', 'u1', 'ALL', { ...dto, consentSource: 'LEADS_INBOUND' }, undefined)).rejects.toThrow(/arquivo/i);
  });

  it('import: canal sem bulk sender é recusado', async () => {
    const { svc, registry } = build();
    registry.hasBulkSender.mockReturnValue(false);
    const dto: any = { channelId: 'ch1', name: 'Teste', consentSource: 'LEADS_INBOUND' };
    await expect(
      svc.import('org1', 'u1', 'ALL', dto, { buffer: Buffer.from('whatsapp,empresa,mensagem\n11999998888,A,Oi') }),
    ).rejects.toThrow(/não suporta envio em massa/);
  });

  describe('webhook de resposta', () => {
    it('maskCampaign nunca devolve o segredo e informa se existe', () => {
      const masked = maskCampaign({ id: 'c', onReplyWebhookSecret: 'whsec_abc' } as any);
      expect(masked).not.toHaveProperty('onReplyWebhookSecret');
      expect(masked.onReplyWebhookSecretSet).toBe(true);
      expect(maskCampaign({ id: 'c', onReplyWebhookSecret: null } as any).onReplyWebhookSecretSet).toBe(false);
    });

    it('update: URL interna é recusada com 422 e nada é gravado', async () => {
      const { svc, prisma } = build();
      prisma.campaign.findFirst.mockResolvedValue({ ...(await prisma.campaign.findFirst()), status: 'DRAFT', onReplyWebhookSecret: null });
      prisma.campaign.update = jest.fn();
      for (const url of ['http://hooks.exemplo.com/x', 'https://127.0.0.1/x', 'https://169.254.169.254/latest', 'https://localhost/x']) {
        await expect(svc.update('org1', 'cmp1', 'ALL', { onReplyWebhookUrl: url } as any)).rejects.toThrow(UnprocessableEntityException);
      }
      expect(prisma.campaign.update).not.toHaveBeenCalled();
    });

    it('update: URL vazia remove webhook e segredo', async () => {
      const { svc, prisma } = build();
      prisma.campaign.findFirst.mockResolvedValue({ ...(await prisma.campaign.findFirst()), status: 'DRAFT', onReplyWebhookSecret: 'whsec_x', onReplyWebhookUrl: 'https://h.example.com/x' });
      prisma.campaign.update = jest.fn().mockResolvedValue({ id: 'cmp1', organizationId: 'org1', onReplyWebhookSecret: null, onReplyWebhookUrl: null });
      prisma.campaignRecipient.count = jest.fn().mockResolvedValue(0);
      await svc.update('org1', 'cmp1', 'ALL', { onReplyWebhookUrl: '' } as any);
      expect(prisma.campaign.update.mock.calls[0][0].data).toMatchObject({ onReplyWebhookUrl: null, onReplyWebhookSecret: null });
    });

    it('rotateWebhookSecret exige URL configurada; devolve o novo segredo só ali', async () => {
      const { svc, prisma } = build();
      prisma.campaign.update = jest.fn().mockResolvedValue({});
      prisma.campaign.findFirst.mockResolvedValue({ ...(await prisma.campaign.findFirst()), onReplyWebhookUrl: null });
      await expect(svc.rotateWebhookSecret('org1', 'cmp1', 'ALL')).rejects.toThrow(ConflictException);
      prisma.campaign.findFirst.mockResolvedValue({ ...(await prisma.campaign.findFirst()), onReplyWebhookUrl: 'https://h.example.com/x' });
      const out = await svc.rotateWebhookSecret('org1', 'cmp1', 'ALL');
      expect(out.webhookSecret).toMatch(/^whsec_[0-9a-f]{48}$/);
    });

    it('testWebhook exige URL e segredo', async () => {
      const { svc, prisma, replyWebhook } = build();
      prisma.campaign.findFirst.mockResolvedValue({ ...(await prisma.campaign.findFirst()), onReplyWebhookUrl: null, onReplyWebhookSecret: null });
      await expect(svc.testWebhook('org1', 'cmp1', 'ALL')).rejects.toThrow(ConflictException);
      expect(replyWebhook.sendTest).not.toHaveBeenCalled();
    });
  });

  describe('rodízio entre chips', () => {
    const chipChannel = (id: string, over: Record<string, any> = {}) => ({
      id, name: `Chip ${id}`, type: 'WHATSAPP_UAZAPI', organizationId: 'org1', isActive: true, deletedAt: null, ...over,
    });

    /** Campanha READY com 2 chips (ch1 primário + ch2) e N destinatários válidos. */
    function multi(n = 6) {
      const ctx = build();
      const { prisma } = ctx;
      prisma.campaign.findFirst.mockResolvedValue({
        id: 'cmp1', organizationId: 'org1', channelId: 'ch1', status: 'READY',
        dailyCap: 20, batchSize: 5, batchSizeMin: 5, startJitterMaxMin: 0, batchPauseMinSec: 60, batchPauseMaxSec: 120,
        sendWindowStart: '00:00', sendWindowEnd: '23:59', sendWeekdays: [0, 1, 2, 3, 4, 5, 6],
        delayMinSec: 30, delayMaxSec: 90, scheduledAt: null,
      });
      prisma.channel.findFirst.mockResolvedValue(chipChannel('ch1'));
      prisma.campaignChannel.findMany.mockResolvedValue([{ channelId: 'ch2', dailyLimit: 20, position: 1, channel: chipChannel('ch2') }]);
      prisma.campaignRecipient.findMany.mockResolvedValue(Array.from({ length: n }, (_, i) => ({ id: `r${i}` })));
      const created: any[] = [];
      const recUpdates: any[] = [];
      const tx: any = {
        $executeRaw: jest.fn().mockResolvedValue(1),
        campaignChannel: { findFirst: jest.fn().mockResolvedValue(null) },
        campaign: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        campaignBatch: {
          create: jest.fn().mockImplementation(async ({ data }: any) => {
            const row = { id: `b${created.length}`, scheduledFor: data.scheduledFor, ...data };
            created.push(row);
            return row;
          }),
        },
        campaignRecipient: { updateMany: jest.fn().mockImplementation(async (a: any) => { recUpdates.push(a); return { count: 1 }; }) },
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
      return { ...ctx, tx, created, recUpdates };
    }

    it('start: cada chip recebe a sua cadeia de lotes, com channelId, e os destinatários são intercalados', async () => {
      const { svc, created, recUpdates, engine } = multi(6);
      const out = await svc.start('org1', 'cmp1', 'ALL');
      expect(out.chips).toBe(2);
      // índices únicos e contínuos na campanha, lotes de AMBOS os chips
      expect(created.map((b) => b.batchIndex)).toEqual(created.map((_, i) => i));
      expect(new Set(created.map((b) => b.channelId))).toEqual(new Set(['ch1', 'ch2']));
      // recipients marcados com o chip dono
      const byChip = new Map<string, string[]>();
      for (const u of recUpdates) {
        const list = byChip.get(u.data.channelId) ?? [];
        list.push(...u.where.id.in);
        byChip.set(u.data.channelId, list);
      }
      expect(byChip.get('ch1')!.sort()).toEqual(['r0', 'r2', 'r4']); // round-robin intercalado
      expect(byChip.get('ch2')!.sort()).toEqual(['r1', 'r3', 'r5']);
      expect(engine.scheduleSubmit).toHaveBeenCalledTimes(created.length);
    });

    it('start: com 1 chip o comportamento é o de sempre (um chip, channelId do primário)', async () => {
      const { svc, prisma, created } = multi(4);
      prisma.campaignChannel.findMany.mockResolvedValue([]);
      const out = await svc.start('org1', 'cmp1', 'ALL');
      expect(out.chips).toBe(1);
      expect(created.every((b) => b.channelId === 'ch1')).toBe(true);
    });

    it('start: um chip desconectado bloqueia e diz QUAL (não deixa outro número esperando em silêncio)', async () => {
      const { svc, engine } = multi(4);
      const bulk = engine.bulkFor();
      bulk.isConnected.mockImplementation(async (ch: any) => ch.id !== 'ch2');
      await expect(svc.start('org1', 'cmp1', 'ALL')).rejects.toThrow(/Chip ch2.*desconectado/);
    });

    it('start: aplica a trava consultiva por chip e recusa se outro chip já está em campanha ativa', async () => {
      const { svc, tx } = multi(4);
      tx.campaignChannel.findFirst.mockResolvedValue({ channel: { name: 'Chip ch2' } });
      await expect(svc.start('org1', 'cmp1', 'ALL')).rejects.toThrow(/Chip ch2.*campanha ativa/);
      expect(tx.$executeRaw).toHaveBeenCalledTimes(2); // uma trava por chip, antes da contagem
      expect(tx.campaign.updateMany).not.toHaveBeenCalled(); // nada inicia
    });

    it('start: o chip não pode estar inativo, de outra org ou sem acesso do usuário', async () => {
      const a = multi(4);
      a.prisma.campaignChannel.findMany.mockResolvedValue([{ channelId: 'ch2', dailyLimit: 20, position: 1, channel: chipChannel('ch2', { isActive: false }) }]);
      await expect(a.svc.start('org1', 'cmp1', 'ALL')).rejects.toThrow(/não está disponível/);

      const b = multi(4);
      b.prisma.campaignChannel.findMany.mockResolvedValue([{ channelId: 'ch2', dailyLimit: 20, position: 1, channel: chipChannel('ch2', { organizationId: 'outra' }) }]);
      await expect(b.svc.start('org1', 'cmp1', 'ALL')).rejects.toThrow(/não está disponível/);
    });

    it('setChannels: exige o chip primário, recusa repetido e valida cada canal', async () => {
      const { svc, prisma } = multi(4);
      prisma.campaign.findFirst.mockResolvedValue({ ...(await prisma.campaign.findFirst()), status: 'DRAFT' });
      await expect(svc.setChannels('org1', 'cmp1', 'ALL', { channels: [{ channelId: 'ch2', dailyLimit: 10 }] })).rejects.toThrow(/primário/);
      await expect(
        svc.setChannels('org1', 'cmp1', 'ALL', { channels: [{ channelId: 'ch1', dailyLimit: 10 }, { channelId: 'ch1', dailyLimit: 10 }] }),
      ).rejects.toThrow(/repetido/);
      prisma.channel.findMany = jest.fn().mockResolvedValue([chipChannel('ch1')]); // ch2 não existe/inativo
      await expect(
        svc.setChannels('org1', 'cmp1', 'ALL', { channels: [{ channelId: 'ch1', dailyLimit: 10 }, { channelId: 'ch2', dailyLimit: 10 }] }),
      ).rejects.toThrow(/não foi encontrado/);
    });

    it('setChannels: só antes de iniciar e canal sem bulk sender é recusado', async () => {
      const { svc, prisma, registry } = multi(4);
      prisma.campaign.findFirst.mockResolvedValue({ ...(await prisma.campaign.findFirst()), status: 'RUNNING' });
      await expect(svc.setChannels('org1', 'cmp1', 'ALL', { channels: [{ channelId: 'ch1', dailyLimit: 10 }] })).rejects.toThrow(/antes de iniciar/);

      prisma.campaign.findFirst.mockResolvedValue({ ...(await prisma.campaign.findFirst()), status: 'DRAFT' });
      prisma.channel.findMany = jest.fn().mockResolvedValue([chipChannel('ch1'), chipChannel('ch2')]);
      registry.hasBulkSender.mockImplementation((t: string) => t === 'WHATSAPP_UAZAPI');
      prisma.channel.findMany.mockResolvedValue([chipChannel('ch1'), chipChannel('ch2', { type: 'GMAIL' })]);
      await expect(
        svc.setChannels('org1', 'cmp1', 'ALL', { channels: [{ channelId: 'ch1', dailyLimit: 10 }, { channelId: 'ch2', dailyLimit: 10 }] }),
      ).rejects.toThrow(/não suporta envio em massa/);
    });

    it('setChannels: grava o rodízio e o teto do primário vira Campaign.dailyCap', async () => {
      const { svc, prisma } = multi(4);
      prisma.campaign.findFirst.mockResolvedValue({ ...(await prisma.campaign.findFirst()), status: 'DRAFT' });
      prisma.channel.findMany = jest.fn().mockResolvedValue([chipChannel('ch1'), chipChannel('ch2')]);
      const tx: any = {
        campaignChannel: { deleteMany: jest.fn(), upsert: jest.fn() },
        campaign: { update: jest.fn() },
      };
      prisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
      prisma.campaignRecipient.count = jest.fn().mockResolvedValue(0);
      prisma.campaignChannel.findMany.mockResolvedValue([]);
      await svc.setChannels('org1', 'cmp1', 'ALL', { channels: [{ channelId: 'ch1', dailyLimit: 30 }, { channelId: 'ch2', dailyLimit: 15 }] });
      expect(tx.campaignChannel.deleteMany).toHaveBeenCalledWith({ where: { campaignId: 'cmp1', channelId: { notIn: ['ch1', 'ch2'] } } });
      expect(tx.campaignChannel.upsert).toHaveBeenCalledTimes(2);
      expect(tx.campaign.update).toHaveBeenCalledWith({ where: { id: 'cmp1' }, data: { dailyCap: 30 } });
    });

    it('estimate com 2 chips: cada um com o seu teto, chips em paralelo (menos dias que 1 chip só)', async () => {
      const { svc, prisma } = multi(400);
      prisma.campaignRecipient.count = jest.fn().mockResolvedValue(400);
      prisma.campaign.findFirst.mockResolvedValue({ ...(await prisma.campaign.findFirst()), status: 'DRAFT', dailyCap: 100 });
      prisma.campaign.update = jest.fn().mockImplementation(async ({ data }: any) => ({
        id: 'cmp1', organizationId: 'org1', channelId: 'ch1', dailyCap: 100, batchSize: 20, batchSizeMin: 20, startJitterMaxMin: 0,
        batchPauseMinSec: 60, batchPauseMaxSec: 120, sendWindowStart: '00:00', sendWindowEnd: '23:59',
        sendWeekdays: [0, 1, 2, 3, 4, 5, 6], delayMinSec: 30, delayMaxSec: 90, scheduledAt: null, ...data,
      }));
      prisma.campaignChannel.findMany.mockResolvedValue([{ channelId: 'ch2', dailyLimit: 100 }]);
      const two: any = await svc.update('org1', 'cmp1', 'ALL', { name: 'x' } as any);
      prisma.campaignChannel.findMany.mockResolvedValue([]);
      const one: any = await svc.update('org1', 'cmp1', 'ALL', { name: 'x' } as any);
      expect(two.estimate.chips).toBe(2);
      expect(one.estimate.chips).toBe(1);
      expect(two.estimate.days).toBeLessThan(one.estimate.days);
    });
  });
});
