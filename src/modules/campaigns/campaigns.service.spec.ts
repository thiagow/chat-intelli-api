import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CampaignsService } from './campaigns.service';

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
  const svc = new CampaignsService(prisma, registry, access, engine, config, queue);
  return { svc, prisma, engine, config, registry };
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
});
