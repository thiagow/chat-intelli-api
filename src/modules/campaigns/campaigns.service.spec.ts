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
    campaignRecipient: { findMany: jest.fn().mockResolvedValue([{ id: 'r1' }]) },
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
});
