import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Campaign, CampaignRecipientStatus, Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../../database/prisma.service';
import { ChannelAdapterRegistry } from '../channel-hub/channel-adapter.registry';
import { ChannelAccess, ChannelAccessService } from '../iam/channel-access/channel-access.service';
import { normalizePhone } from '../../common/phone/phone-normalizer';
import { planBatches } from './batching/campaign-batch-planner';
import { parseCampaignCsv } from './csv/campaign-csv.parser';
import { CampaignsEngine } from './campaigns.engine';
import { CAMPAIGNS_QUEUE, CAMPAIGN_JOBS, CAMPAIGN_LIMITS } from './campaigns.constants';
import {
  ImportCampaignDto,
  ListCampaignsQueryDto,
  ListRecipientsQueryDto,
  UpdateCampaignDto,
} from './dto/campaign.dto';

const EDITABLE: Campaign['status'][] = ['DRAFT', 'VALIDATING', 'READY'];

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly channelAccess: ChannelAccessService,
    private readonly engine: CampaignsEngine,
    private readonly config: ConfigService,
    @InjectQueue(CAMPAIGNS_QUEUE) private readonly queue: Queue,
  ) {}

  /** Kill switch (`CAMPAIGNS_ENABLED=false` desliga a criação/início). */
  assertEnabled(): void {
    if (this.config.get<string>('CAMPAIGNS_ENABLED', 'true') === 'false') {
      throw new ConflictException('Campanhas estão desativadas neste ambiente');
    }
  }

  private async getOwned(orgId: string, id: string, access: ChannelAccess) {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id, organizationId: orgId, deletedAt: null },
    });
    if (!campaign) throw new NotFoundException('Campanha não encontrada');
    this.channelAccess.assertChannelAccess(access, campaign.channelId);
    return campaign;
  }

  // ─── Leitura ───────────────────────────────────────────────────────

  async capabilities(orgId: string, access: ChannelAccess) {
    const channels = await this.prisma.channel.findMany({
      where: { organizationId: orgId, deletedAt: null, isActive: true },
      select: { id: true, name: true, type: true },
      orderBy: { name: 'asc' },
    });
    const capable = channels.filter(
      (c) => this.registry.hasBulkSender(c.type) && this.channelAccess.hasAccess(access, c.id),
    );
    const enabled = this.config.get<string>('CAMPAIGNS_ENABLED', 'true') !== 'false';
    return {
      enabled,
      channels: capable.map((c) => ({ ...c })),
      limits: {
        maxRows: CAMPAIGN_LIMITS.maxRows,
        maxFileBytes: CAMPAIGN_LIMITS.maxFileBytes,
        maxDailyCap: CAMPAIGN_LIMITS.maxDailyCap,
        maxBatchSize: CAMPAIGN_LIMITS.maxBatchSize,
        minBatchPauseSec: CAMPAIGN_LIMITS.minBatchPauseSec,
        maxBatchPauseSec: CAMPAIGN_LIMITS.maxBatchPauseSec,
        minDelaySec: CAMPAIGN_LIMITS.minDelaySec,
        maxDelaySec: CAMPAIGN_LIMITS.maxDelaySec,
      },
    };
  }

  async list(orgId: string, access: ChannelAccess, q: ListCampaignsQueryDto) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 20;
    const where: Prisma.CampaignWhereInput = {
      organizationId: orgId,
      deletedAt: null,
      ...(access !== 'ALL' && { channelId: { in: [...access] } }),
    };
    const [items, total] = await Promise.all([
      this.prisma.campaign.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { channel: { select: { id: true, name: true, type: true } } },
      }),
      this.prisma.campaign.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async get(orgId: string, id: string, access: ChannelAccess) {
    const campaign = await this.getOwned(orgId, id, access);
    const [stats, batches, channel] = await Promise.all([
      this.engine.computeStats(id),
      this.prisma.campaignBatch.findMany({ where: { campaignId: id }, orderBy: { batchIndex: 'asc' } }),
      this.prisma.channel.findUnique({ where: { id: campaign.channelId }, select: { id: true, name: true, type: true } }),
    ]);
    return { ...campaign, stats, batches, channel, estimate: await this.estimate(campaign) };
  }

  async recipients(orgId: string, id: string, access: ChannelAccess, q: ListRecipientsQueryDto) {
    await this.getOwned(orgId, id, access);
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 50;
    const where: Prisma.CampaignRecipientWhereInput = {
      campaignId: id,
      organizationId: orgId,
      ...(q.status && { status: q.status }),
      ...(q.replied && { repliedAt: { not: null } }),
    };
    const [items, total] = await Promise.all([
      this.prisma.campaignRecipient.findMany({
        where,
        orderBy: { rowNumber: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          rowNumber: true,
          rawPhone: true,
          phoneE164: true,
          companyName: true,
          messageText: true,
          status: true,
          invalidReason: true,
          error: true,
          sentAt: true,
          deliveredAt: true,
          readAt: true,
          repliedAt: true,
          conversationId: true,
          batchId: true,
        },
      }),
      this.prisma.campaignRecipient.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  /** Duração estimada considerando teto efetivo, janela e dias. */
  private async estimate(campaign: Campaign) {
    const sendable = await this.prisma.campaignRecipient.count({
      where: { campaignId: campaign.id, status: { in: ['PENDING', 'VALID'] } },
    });
    const org = await this.prisma.organization.findUnique({
      where: { id: campaign.organizationId },
      select: { aiTimezone: true },
    });
    try {
      const plan = planBatches({
        recipientCount: sendable,
        dailyCap: campaign.dailyCap,
        windowStart: campaign.sendWindowStart,
        windowEnd: campaign.sendWindowEnd,
        weekdays: campaign.sendWeekdays,
        timezone: org?.aiTimezone || 'America/Sao_Paulo',
        delayMinSec: campaign.delayMinSec,
        delayMaxSec: campaign.delayMaxSec,
        notBefore: campaign.scheduledAt && campaign.scheduledAt > new Date() ? campaign.scheduledAt : new Date(),
        batchSize: campaign.batchSize,
        batchSizeMin: campaign.batchSizeMin,
        startJitterMaxMin: campaign.startJitterMaxMin,
        batchPauseMinSec: campaign.batchPauseMinSec,
        batchPauseMaxSec: campaign.batchPauseMaxSec,
      });
      return {
        recipients: sendable,
        days: plan.days,
        batches: plan.batches.length,
        effectiveDailyCap: plan.effectiveDailyCap,
        capLimitedByWindow: plan.capLimitedByWindow,
        firstBatchAt: plan.batches[0]?.scheduledFor ?? null,
        estimatedEnd: plan.estimatedEnd,
      };
    } catch (err: any) {
      return { recipients: sendable, error: err.message };
    }
  }

  // ─── Import ────────────────────────────────────────────────────────

  async import(
    orgId: string,
    userId: string,
    access: ChannelAccess,
    dto: ImportCampaignDto,
    file: { buffer: Buffer; originalname?: string } | undefined,
  ) {
    this.assertEnabled();
    if (!file) throw new BadRequestException('Envie o arquivo CSV no campo "file"');
    if (dto.consentSource === 'OUTRO' && !dto.consentNote?.trim()) {
      throw new UnprocessableEntityException('Descreva a origem da lista (consentNote) quando a origem for "Outro"');
    }

    const channel = await this.prisma.channel.findFirst({
      where: { id: dto.channelId, organizationId: orgId, deletedAt: null, isActive: true },
    });
    if (!channel) throw new NotFoundException('Canal não encontrado');
    this.channelAccess.assertChannelAccess(access, channel.id);
    if (!this.registry.hasBulkSender(channel.type)) {
      throw new UnprocessableEntityException('Este canal não suporta envio em massa');
    }

    const rows = parseCampaignCsv(file.buffer);

    // Classificação linha a linha.
    type Draft = {
      rowNumber: number;
      rawPhone: string;
      phoneE164: string | null;
      companyName: string;
      messageText: string;
      status: CampaignRecipientStatus;
      invalidReason: string | null;
    };
    const seen = new Set<string>();
    const drafts: Draft[] = rows.map((r) => {
      const base = {
        rowNumber: r.rowNumber,
        rawPhone: r.rawPhone.slice(0, 64),
        companyName: r.companyName.slice(0, 200),
        messageText: r.messageText,
      };
      const phone = normalizePhone(r.rawPhone);
      if (!phone.ok) {
        return { ...base, phoneE164: null, status: 'INVALID', invalidReason: phone.reason === 'EMPTY' ? 'PHONE_EMPTY' : 'PHONE_INVALID' };
      }
      if (r.error) return { ...base, phoneE164: phone.e164, status: 'INVALID', invalidReason: r.error };
      if (/\{\{\s*empresa\s*\}\}/i.test(r.messageText) && !r.companyName) {
        return { ...base, phoneE164: phone.e164, status: 'INVALID', invalidReason: 'COMPANY_REQUIRED' };
      }
      if (seen.has(phone.e164)) {
        return { ...base, phoneE164: null, status: 'DUPLICATE', invalidReason: 'DUPLICATE_IN_FILE' };
      }
      seen.add(phone.e164);
      return { ...base, phoneE164: phone.e164, status: 'PENDING', invalidReason: null };
    });

    const optedOut = await this.engine.findOptedOut(orgId, [...seen]);
    for (const d of drafts) {
      if (d.status === 'PENDING' && optedOut.has(d.phoneE164!)) {
        d.status = 'OPTED_OUT';
        d.invalidReason = 'OPTED_OUT';
        // OPTED_OUT mantém o E.164 (útil no relatório), único por campanha.
      }
    }

    const pending = drafts.filter((d) => d.status === 'PENDING').length;
    const campaign = await this.prisma.$transaction(
      async (tx) => {
        const created = await tx.campaign.create({
          data: {
            organizationId: orgId,
            channelId: channel.id,
            createdById: userId,
            name: dto.name.trim(),
            status: pending > 0 ? 'VALIDATING' : 'READY',
            consentSource: dto.consentSource,
            consentNote: dto.consentNote?.trim() || null,
            sourceFileName: file.originalname?.slice(0, 200) ?? null,
          },
        });
        for (let i = 0; i < drafts.length; i += 1000) {
          await tx.campaignRecipient.createMany({
            data: drafts.slice(i, i + 1000).map((d) => ({
              campaignId: created.id,
              organizationId: orgId,
              rowNumber: d.rowNumber,
              rawPhone: d.rawPhone,
              phoneE164: d.phoneE164,
              companyName: d.companyName,
              messageText: d.messageText,
              status: d.status,
              invalidReason: d.invalidReason,
            })),
          });
        }
        return created;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );

    if (pending > 0) {
      await this.queue.add(
        CAMPAIGN_JOBS.VALIDATE_NUMBERS,
        { campaignId: campaign.id },
        { attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: true, removeOnFail: true },
      );
    }
    const stats = await this.engine.emitProgress(campaign.id);

    return {
      campaign: { ...campaign, stats },
      report: {
        total: drafts.length,
        pending,
        invalid: drafts.filter((d) => d.status === 'INVALID').length,
        duplicate: drafts.filter((d) => d.status === 'DUPLICATE').length,
        optedOut: drafts.filter((d) => d.status === 'OPTED_OUT').length,
        rows: drafts
          .filter((d) => d.status !== 'PENDING')
          .map((d) => ({
            rowNumber: d.rowNumber,
            rawPhone: d.rawPhone,
            companyName: d.companyName,
            status: d.status,
            reason: d.invalidReason,
          })),
      },
    };
  }

  // ─── Configuração ──────────────────────────────────────────────────

  async update(orgId: string, id: string, access: ChannelAccess, dto: UpdateCampaignDto) {
    const campaign = await this.getOwned(orgId, id, access);
    if (!EDITABLE.includes(campaign.status)) {
      throw new ConflictException('A campanha não pode mais ser editada neste estado');
    }

    const next = {
      delayMinSec: dto.delayMinSec ?? campaign.delayMinSec,
      delayMaxSec: dto.delayMaxSec ?? campaign.delayMaxSec,
      sendWindowStart: dto.sendWindowStart ?? campaign.sendWindowStart,
      sendWindowEnd: dto.sendWindowEnd ?? campaign.sendWindowEnd,
      batchPauseMinSec: dto.batchPauseMinSec ?? campaign.batchPauseMinSec,
      batchPauseMaxSec: dto.batchPauseMaxSec ?? campaign.batchPauseMaxSec,
    };
    // Faixa de verdade: pausa fixa entre lotes é um padrão fácil de detectar como robô.
    if (next.batchPauseMaxSec <= next.batchPauseMinSec) {
      throw new UnprocessableEntityException('A pausa máxima entre lotes precisa ser maior que a mínima (pausa fixa é detectável)');
    }
    const sizeMax = dto.batchSize ?? campaign.batchSize;
    // Reduzir só o máximo leva o mínimo junto (em vez de erro).
    const sizeMin = dto.batchSizeMin ?? Math.min(campaign.batchSizeMin, sizeMax);
    if (sizeMin > sizeMax) {
      throw new UnprocessableEntityException('O tamanho mínimo do lote não pode ser maior que o máximo');
    }
    const typingMin = dto.typingMinMs ?? campaign.typingMinMs;
    const typingMax = dto.typingMaxMs ?? campaign.typingMaxMs;
    if (typingMax > 0 && typingMax < typingMin) {
      throw new UnprocessableEntityException('A digitação máxima precisa ser maior ou igual à mínima');
    }
    if (next.delayMaxSec < next.delayMinSec) {
      throw new UnprocessableEntityException('O intervalo máximo precisa ser maior ou igual ao mínimo');
    }
    const toMin = (hm: string) => Number(hm.split(':')[0]) * 60 + Number(hm.split(':')[1]);
    if (toMin(next.sendWindowEnd) <= toMin(next.sendWindowStart)) {
      throw new UnprocessableEntityException('A janela de envio precisa terminar depois de começar');
    }
    if (dto.scheduledAt && new Date(dto.scheduledAt) <= new Date()) {
      throw new UnprocessableEntityException('O agendamento precisa estar no futuro');
    }

    const updated = await this.prisma.campaign.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(dto.delayMinSec !== undefined && { delayMinSec: dto.delayMinSec }),
        ...(dto.delayMaxSec !== undefined && { delayMaxSec: dto.delayMaxSec }),
        ...(dto.scheduledAt !== undefined && { scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null }),
        ...(dto.replyRouting !== undefined && { replyRouting: dto.replyRouting }),
        ...(dto.replyWindowDays !== undefined && { replyWindowDays: dto.replyWindowDays }),
        ...(dto.dailyCap !== undefined && { dailyCap: dto.dailyCap }),
        ...(dto.batchSize !== undefined && { batchSize: dto.batchSize }),
        ...((dto.batchSizeMin !== undefined || dto.batchSize !== undefined) && { batchSizeMin: sizeMin }),
        ...(dto.startJitterMaxMin !== undefined && { startJitterMaxMin: dto.startJitterMaxMin }),
        ...(dto.typingMinMs !== undefined && { typingMinMs: dto.typingMinMs }),
        ...(dto.typingMaxMs !== undefined && { typingMaxMs: dto.typingMaxMs }),
        ...(dto.batchPauseMinSec !== undefined && { batchPauseMinSec: dto.batchPauseMinSec }),
        ...(dto.batchPauseMaxSec !== undefined && { batchPauseMaxSec: dto.batchPauseMaxSec }),
        ...(dto.sendWindowStart !== undefined && { sendWindowStart: dto.sendWindowStart }),
        ...(dto.sendWindowEnd !== undefined && { sendWindowEnd: dto.sendWindowEnd }),
        ...(dto.sendWeekdays !== undefined && { sendWeekdays: [...new Set(dto.sendWeekdays)].sort() }),
        ...(dto.maxFailureRatePct !== undefined && { maxFailureRatePct: dto.maxFailureRatePct }),
        ...(dto.appendOptOutFooter !== undefined && { appendOptOutFooter: dto.appendOptOutFooter }),
      },
    });
    return { ...updated, estimate: await this.estimate(updated) };
  }

  // ─── Ciclo de vida ─────────────────────────────────────────────────

  async start(orgId: string, id: string, access: ChannelAccess) {
    this.assertEnabled();
    const campaign = await this.getOwned(orgId, id, access);
    if (campaign.status !== 'READY') {
      throw new ConflictException('A campanha precisa estar validada (READY) para iniciar');
    }
    const channel = await this.prisma.channel.findFirst({
      where: { id: campaign.channelId, organizationId: orgId, deletedAt: null, isActive: true },
    });
    if (!channel) throw new NotFoundException('Canal não encontrado');
    const bulk = this.engine.bulkFor(channel);

    const connected = await bulk.isConnected(channel).catch(() => true);
    if (!connected) throw new ConflictException('O canal está desconectado. Reconecte antes de iniciar');

    const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { aiTimezone: true } });
    const valid = await this.prisma.campaignRecipient.findMany({
      where: { campaignId: id, status: 'VALID' },
      orderBy: { rowNumber: 'asc' },
      select: { id: true },
    });
    if (!valid.length) throw new UnprocessableEntityException('Nenhum destinatário válido para enviar');

    const plan = planBatches({
      recipientCount: valid.length,
      dailyCap: campaign.dailyCap,
      windowStart: campaign.sendWindowStart,
      windowEnd: campaign.sendWindowEnd,
      weekdays: campaign.sendWeekdays,
      timezone: org?.aiTimezone || 'America/Sao_Paulo',
      delayMinSec: campaign.delayMinSec,
      delayMaxSec: campaign.delayMaxSec,
      notBefore: campaign.scheduledAt && campaign.scheduledAt > new Date() ? campaign.scheduledAt : new Date(),
      batchSize: campaign.batchSize,
      batchSizeMin: campaign.batchSizeMin,
      startJitterMaxMin: campaign.startJitterMaxMin,
      batchPauseMinSec: campaign.batchPauseMinSec,
      batchPauseMaxSec: campaign.batchPauseMaxSec,
    });

    // Webhook precisa assinar `sender` (canais antigos foram configurados sem ele).
    const appUrl = this.config.get<string>('APP_URL');
    if (appUrl) {
      await bulk
        .ensureWebhook(channel, `${appUrl}/api/v1/webhooks/${channel.type}`)
        .catch((e) => this.logger.warn(`ensureWebhook falhou: ${e.message}`));
    } else {
      this.logger.warn('APP_URL ausente: eventos "sender" não chegam; o reconcile cobre os status');
    }

    // Transição + lotes numa transação. O índice parcial garante 1 campanha ativa por canal.
    let batches: Array<{ id: string; scheduledFor: Date }>;
    try {
      batches = await this.prisma.$transaction(async (tx) => {
        const moved = await tx.campaign.updateMany({
          where: { id, status: 'READY' },
          data: { status: 'SUBMITTING', startedAt: new Date(), errorMessage: null, autoPausedReason: null },
        });
        if (!moved.count) throw new ConflictException('A campanha já foi iniciada');

        const created: Array<{ id: string; scheduledFor: Date }> = [];
        let offset = 0;
        for (const p of plan.batches) {
          const row = await tx.campaignBatch.create({
            data: { campaignId: id, batchIndex: p.batchIndex, scheduledFor: p.scheduledFor, recipientCount: p.size },
          });
          await tx.campaignRecipient.updateMany({
            where: { id: { in: valid.slice(offset, offset + p.size).map((v) => v.id) } },
            data: { batchId: row.id },
          });
          offset += p.size;
          created.push(row);
        }
        return created;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Já existe uma campanha ativa neste canal. Finalize ou cancele a anterior');
      }
      throw err;
    }

    for (const b of batches) await this.engine.scheduleSubmit(id, b);
    await this.engine.scheduleReconcile(id);
    await this.engine.emitProgress(id);

    return {
      id,
      status: 'SUBMITTING',
      batches: plan.batches.length,
      effectiveDailyCap: plan.effectiveDailyCap,
      capLimitedByWindow: plan.capLimitedByWindow,
      estimatedEnd: plan.estimatedEnd,
    };
  }

  async pause(orgId: string, id: string, access: ChannelAccess) {
    const c = await this.getOwned(orgId, id, access);
    if (!['SUBMITTING', 'SCHEDULED', 'RUNNING'].includes(c.status)) {
      throw new ConflictException('Só é possível pausar uma campanha em andamento');
    }
    await this.engine.pauseCampaign(id, null);
    return this.get(orgId, id, access);
  }

  async resume(orgId: string, id: string, access: ChannelAccess) {
    this.assertEnabled();
    const c = await this.getOwned(orgId, id, access);
    if (c.status !== 'PAUSED') throw new ConflictException('A campanha não está pausada');
    await this.engine.resumeCampaign(id);
    return this.get(orgId, id, access);
  }

  async cancel(orgId: string, id: string, access: ChannelAccess) {
    const c = await this.getOwned(orgId, id, access);
    if (['COMPLETED', 'CANCELLED', 'FAILED'].includes(c.status)) {
      throw new ConflictException('A campanha já foi encerrada');
    }
    await this.engine.cancelCampaign(id);
    return this.get(orgId, id, access);
  }

  async sendNow(orgId: string, id: string, access: ChannelAccess) {
    const c = await this.getOwned(orgId, id, access);
    if (!['SUBMITTING', 'SCHEDULED'].includes(c.status)) {
      throw new ConflictException('Só dá para antecipar uma campanha iniciada e ainda não em andamento');
    }
    const n = await this.engine.sendNow(id);
    if (!n) throw new ConflictException('Nenhum lote agendado para antecipar');
    return { batchesStarted: n };
  }
}
