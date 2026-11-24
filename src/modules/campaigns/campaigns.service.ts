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
import { Campaign, CampaignRecipientStatus, Channel, Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../../database/prisma.service';
import { ChannelAdapterRegistry } from '../channel-hub/channel-adapter.registry';
import { ChannelAccess, ChannelAccessService } from '../iam/channel-access/channel-access.service';
import { normalizePhone } from '../../common/phone/phone-normalizer';
import { planChips, summarizeChipPlans } from './batching/campaign-chip-planner';
import { parseCampaignCsv } from './csv/campaign-csv.parser';
import { extractVariables, renderCampaignMessage } from './campaign-text';
import { randomBytes } from 'node:crypto';
import { assertSafeHttpsUrl, UnsafeUrlError } from '../../common/net/safe-fetch';
import { ReplyWebhookService } from './reply-webhook.service';
import { CampaignsEngine } from './campaigns.engine';
import { ACTIVE_CAMPAIGN_STATUSES, CAMPAIGNS_QUEUE, CAMPAIGN_JOBS, CAMPAIGN_LIMITS } from './campaigns.constants';
import {
  ImportCampaignDto,
  ListCampaignsQueryDto,
  ListRecipientsQueryDto,
  PreviewCampaignQueryDto,
  SetCampaignChannelsDto,
  UpdateCampaignDto,
} from './dto/campaign.dto';

const EDITABLE: Campaign['status'][] = ['DRAFT', 'VALIDATING', 'READY'];

/** Nunca devolve o segredo do webhook: qualquer membro com acesso ao canal lê a campanha. */
export function maskCampaign<T extends { onReplyWebhookSecret?: string | null }>(c: T) {
  const { onReplyWebhookSecret, ...rest } = c;
  return { ...rest, onReplyWebhookSecretSet: !!onReplyWebhookSecret };
}

const newWebhookSecret = () => `whsec_${randomBytes(24).toString('hex')}`;

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
    private readonly replyWebhook: ReplyWebhookService,
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
    return { items: items.map((c) => maskCampaign(c)), total, page, pageSize };
  }

  async get(orgId: string, id: string, access: ChannelAccess) {
    const campaign = await this.getOwned(orgId, id, access);
    const [stats, batches, channel] = await Promise.all([
      this.engine.computeStats(id),
      this.prisma.campaignBatch.findMany({ where: { campaignId: id }, orderBy: { batchIndex: 'asc' } }),
      this.prisma.channel.findUnique({ where: { id: campaign.channelId }, select: { id: true, name: true, type: true } }),
    ]);
    return {
      ...maskCampaign(campaign),
      stats,
      batches,
      channel,
      channels: await this.chipBreakdown(campaign),
      estimate: await this.estimate(campaign),
    };
  }

  /** Pré-visualização: mesma renderização do envio, com sementes de amostra diferentes. */
  async preview(orgId: string, id: string, access: ChannelAccess, q: PreviewCampaignQueryDto) {
    const campaign = await this.getOwned(orgId, id, access);
    const sample = await this.prisma.campaignRecipient.findFirst({
      where: { campaignId: id, organizationId: orgId, status: { in: ['PENDING', 'VALID', 'QUEUED'] } },
      orderBy: { rowNumber: 'asc' },
    });
    if (!sample) return { variations: [], variables: [], sample: null };
    const footer = q.footer ?? campaign.appendOptOutFooter;
    const n = q.n ?? 3;
    const variations = Array.from({ length: n }, (_, i) =>
      renderCampaignMessage({
        template: sample.messageText,
        companyName: sample.companyName,
        customData: (sample.customData ?? null) as Record<string, string> | null,
        seed: `preview:${id}:${i}`,
        appendOptOutFooter: footer,
      }).text,
    );
    return {
      variations,
      variables: extractVariables(sample.messageText),
      sample: { companyName: sample.companyName },
    };
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
  /** Chips da campanha: o primário (teto = `Campaign.dailyCap`) + os demais do rodízio. */
  private async chipSpecs(campaign: Campaign): Promise<Array<{ channelId: string; dailyLimit: number }>> {
    const rows = await this.prisma.campaignChannel.findMany({
      where: { campaignId: campaign.id, channelId: { not: campaign.channelId } },
      orderBy: { position: 'asc' },
      select: { channelId: true, dailyLimit: true },
    });
    return [{ channelId: campaign.channelId, dailyLimit: campaign.dailyCap }, ...rows];
  }

  /** Progresso por chip para o detalhe da campanha. */
  private async chipBreakdown(campaign: Campaign) {
    const [rows, groups] = await Promise.all([
      this.prisma.campaignChannel.findMany({
        where: { campaignId: campaign.id },
        orderBy: { position: 'asc' },
        include: { channel: { select: { id: true, name: true, type: true } } },
      }),
      this.prisma.campaignRecipient.groupBy({
        by: ['channelId', 'status'],
        where: { campaignId: campaign.id },
        orderBy: [{ channelId: 'asc' }, { status: 'asc' }],
        _count: { _all: true },
      } as never) as unknown as Promise<Array<{ channelId: string | null; status: string; _count: { _all: number } }>>,
    ]);
    const stats = new Map<string, Record<string, number>>();
    for (const g of groups) {
      const key = g.channelId ?? campaign.channelId;
      const cur = stats.get(key) ?? { queued: 0, sent: 0, delivered: 0, read: 0, failed: 0 };
      const n = g._count._all;
      if (g.status === 'QUEUED') cur.queued += n;
      if (['SENT', 'DELIVERED', 'READ'].includes(g.status)) cur.sent += n;
      if (['DELIVERED', 'READ'].includes(g.status)) cur.delivered += n;
      if (g.status === 'READ') cur.read += n;
      if (g.status === 'FAILED') cur.failed += n;
      stats.set(key, cur);
    }
    return rows.map((r) => ({
      channelId: r.channelId,
      name: r.channel.name,
      type: r.channel.type,
      isPrimary: r.channelId === campaign.channelId,
      dailyLimit: r.channelId === campaign.channelId ? campaign.dailyCap : r.dailyLimit,
      stats: stats.get(r.channelId) ?? { queued: 0, sent: 0, delivered: 0, read: 0, failed: 0 },
    }));
  }

  private async estimate(campaign: Campaign) {
    const sendable = await this.prisma.campaignRecipient.count({
      where: { campaignId: campaign.id, status: { in: ['PENDING', 'VALID'] } },
    });
    const org = await this.prisma.organization.findUnique({
      where: { id: campaign.organizationId },
      select: { aiTimezone: true },
    });
    try {
      const chips = await this.chipSpecs(campaign);
      const plans = planChips(chips, sendable, {
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
      const sum = summarizeChipPlans(plans);
      return {
        recipients: sendable,
        days: sum.days,
        batches: sum.batches,
        chips: chips.length,
        effectiveDailyCap: sum.effectiveDailyCap,
        capLimitedByWindow: sum.capLimitedByWindow,
        firstBatchAt: sum.firstBatchAt,
        estimatedEnd: sum.estimatedEnd,
      };
    } catch (err: any) {
      return { recipients: sendable, error: err.message };
    }
  }

  /**
   * Define os chips (canais) do rodízio e o teto diário de cada um. O canal primário é obrigatório e seu
   * teto é `Campaign.dailyCap` (fonte da verdade). Só antes de iniciar.
   */
  async setChannels(orgId: string, id: string, access: ChannelAccess, dto: SetCampaignChannelsDto) {
    const campaign = await this.getOwned(orgId, id, access);
    if (!EDITABLE.includes(campaign.status)) {
      throw new ConflictException('Os canais só podem ser alterados antes de iniciar a campanha');
    }
    const ids = dto.channels.map((c) => c.channelId);
    if (new Set(ids).size !== ids.length) throw new UnprocessableEntityException('Canal repetido na lista');
    if (!ids.includes(campaign.channelId)) {
      throw new UnprocessableEntityException('O canal da campanha (primário) precisa continuar no rodízio');
    }

    const found = await this.prisma.channel.findMany({
      where: { id: { in: ids }, organizationId: orgId, deletedAt: null, isActive: true },
    });
    for (const cid of ids) {
      const ch = found.find((c) => c.id === cid);
      if (!ch) throw new NotFoundException('Um dos canais não foi encontrado ou está inativo');
      this.channelAccess.assertChannelAccess(access, ch.id);
      if (!this.registry.hasBulkSender(ch.type)) {
        throw new UnprocessableEntityException(`O canal "${ch.name}" não suporta envio em massa`);
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.campaignChannel.deleteMany({ where: { campaignId: id, channelId: { notIn: ids } } });
      for (const [position, item] of dto.channels.entries()) {
        const isPrimary = item.channelId === campaign.channelId;
        await tx.campaignChannel.upsert({
          where: { uq_campaign_channel: { campaignId: id, channelId: item.channelId } },
          create: { campaignId: id, channelId: item.channelId, dailyLimit: item.dailyLimit, position: isPrimary ? 0 : position + 1 },
          update: { dailyLimit: item.dailyLimit, position: isPrimary ? 0 : position + 1 },
        });
        if (isPrimary) await tx.campaign.update({ where: { id }, data: { dailyCap: item.dailyLimit } });
      }
    });

    const fresh = await this.getOwned(orgId, id, access);
    return { channels: await this.chipBreakdown(fresh), estimate: await this.estimate(fresh) };
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
      customData: Record<string, string>;
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
        customData: r.customData,
      };
      const phone = normalizePhone(r.rawPhone);
      if (!phone.ok) {
        return { ...base, phoneE164: null, status: 'INVALID', invalidReason: phone.reason === 'EMPTY' ? 'PHONE_EMPTY' : 'PHONE_INVALID' };
      }
      if (r.error) return { ...base, phoneE164: phone.e164, status: 'INVALID', invalidReason: r.error };
      if (/\{\{\s*empresa\s*\}\}/i.test(r.messageText) && !r.companyName) {
        return { ...base, phoneE164: phone.e164, status: 'INVALID', invalidReason: 'COMPANY_REQUIRED' };
      }
      // Variável do modelo sem valor nesta linha: nunca envia "{{cidade}}" cru nem um buraco no texto.
      const missingVar = extractVariables(r.messageText).find((v) => v !== 'empresa' && !r.customData[v]);
      if (missingVar) {
        return { ...base, phoneE164: phone.e164, status: 'INVALID', invalidReason: `VARIABLE_MISSING:${missingVar}`.slice(0, 80) };
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
            // O canal do import é o chip primário do rodízio (outros chips entram em PUT /:id/channels).
            channels: { create: { channelId: channel.id, dailyLimit: 200, position: 0 } },
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
              customData: d.customData,
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
      campaign: { ...maskCampaign(campaign), stats },
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

    // Webhook de resposta: URL validada contra SSRF ao salvar (e de novo a cada entrega).
    let webhookPatch: { onReplyWebhookUrl: string | null; onReplyWebhookSecret?: string | null } | null = null;
    let generatedSecret: string | undefined;
    if (dto.onReplyWebhookUrl !== undefined) {
      const raw = (dto.onReplyWebhookUrl ?? '').trim();
      if (!raw) {
        webhookPatch = { onReplyWebhookUrl: null, onReplyWebhookSecret: null };
      } else {
        try {
          await assertSafeHttpsUrl(raw);
        } catch (err) {
          if (err instanceof UnsafeUrlError) throw new UnprocessableEntityException(`URL do webhook recusada: ${err.message}`);
          throw err;
        }
        webhookPatch = { onReplyWebhookUrl: raw };
        if (!campaign.onReplyWebhookSecret) {
          generatedSecret = newWebhookSecret();
          webhookPatch.onReplyWebhookSecret = generatedSecret;
        }
      }
    }

    const updated = await this.prisma.campaign.update({
      where: { id },
      data: {
        ...(webhookPatch ?? {}),
        ...(dto.replyAiContext !== undefined && { replyAiContext: dto.replyAiContext?.trim() || null }),
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
    if (dto.dailyCap !== undefined) {
      // `Campaign.dailyCap` é o teto do chip primário: mantém a linha do rodízio coerente.
      await this.prisma.campaignChannel.updateMany({
        where: { campaignId: id, channelId: campaign.channelId },
        data: { dailyLimit: dto.dailyCap },
      });
    }
    // O segredo só sai UMA vez, na resposta que o gerou (ou na rotação); depois só `onReplyWebhookSecretSet`.
    return { ...maskCampaign(updated), estimate: await this.estimate(updated), ...(generatedSecret && { webhookSecret: generatedSecret }) };
  }

  // ─── Ciclo de vida ─────────────────────────────────────────────────

  async start(orgId: string, id: string, access: ChannelAccess) {
    this.assertEnabled();
    const campaign = await this.getOwned(orgId, id, access);
    if (campaign.status !== 'READY') {
      throw new ConflictException('A campanha precisa estar validada (READY) para iniciar');
    }

    // Chips do rodízio: o primário + os demais, todos ativos, com acesso, com bulk sender e conectados.
    const primary = await this.prisma.channel.findFirst({
      where: { id: campaign.channelId, organizationId: orgId, deletedAt: null, isActive: true },
    });
    if (!primary) throw new NotFoundException('Canal não encontrado');
    const extraRows = await this.prisma.campaignChannel.findMany({
      where: { campaignId: id, channelId: { not: campaign.channelId } },
      orderBy: { position: 'asc' },
      include: { channel: true },
    });
    const chips: Array<{ channel: Channel; dailyLimit: number }> = [
      { channel: primary, dailyLimit: campaign.dailyCap },
      ...extraRows.map((r) => ({ channel: r.channel, dailyLimit: r.dailyLimit })),
    ];
    for (const [i, { channel }] of chips.entries()) {
      // O primário já foi filtrado por org/ativo na consulta; os demais chips vêm do rodízio e são revalidados.
      if (i > 0 && (channel.deletedAt || !channel.isActive || channel.organizationId !== orgId)) {
        throw new NotFoundException(`O canal "${channel.name}" não está disponível`);
      }
      this.channelAccess.assertChannelAccess(access, channel.id);
      const bulk = this.engine.bulkFor(channel);
      const connected = await bulk.isConnected(channel).catch(() => true);
      if (!connected) {
        throw new ConflictException(
          chips.length > 1
            ? `O canal "${channel.name}" está desconectado. Reconecte ou remova-o do rodízio antes de iniciar`
            : 'O canal está desconectado. Reconecte antes de iniciar',
        );
      }
    }

    const org = await this.prisma.organization.findUnique({ where: { id: orgId }, select: { aiTimezone: true } });
    const valid = await this.prisma.campaignRecipient.findMany({
      where: { campaignId: id, status: 'VALID' },
      orderBy: { rowNumber: 'asc' },
      select: { id: true },
    });
    if (!valid.length) throw new UnprocessableEntityException('Nenhum destinatário válido para enviar');

    // Cada chip planeja a própria cadeia de lotes (teto, pausas e jitter de início independentes).
    const plans = planChips(
      chips.map((c) => ({ channelId: c.channel.id, dailyLimit: c.dailyLimit })),
      valid.length,
      {
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
      },
    );
    const summary = summarizeChipPlans(plans);

    // Webhook precisa assinar `sender` em CADA chip (canais antigos foram configurados sem ele).
    const appUrl = this.config.get<string>('APP_URL');
    if (appUrl) {
      for (const { channel } of chips) {
        await this.engine
          .bulkFor(channel)
          .ensureWebhook(channel, `${appUrl}/api/v1/webhooks/${channel.type}`)
          .catch((e) => this.logger.warn(`ensureWebhook falhou (${channel.name}): ${e.message}`));
      }
    } else {
      this.logger.warn('APP_URL ausente: eventos "sender" não chegam; o reconcile cobre os status');
    }

    // Transição + lotes numa transação. Garantia de "uma campanha ativa por chip": o índice parcial cobre
    // o canal primário; para os demais, trava consultiva por canal + contagem dentro da transação.
    let batches: Array<{ id: string; scheduledFor: Date }>;
    try {
      batches = await this.prisma.$transaction(async (tx) => {
        await this.assertChipsFree(tx, id, chips.map((c) => ({ id: c.channel.id, name: c.channel.name })));

        const moved = await tx.campaign.updateMany({
          where: { id, status: 'READY' },
          data: { status: 'SUBMITTING', startedAt: new Date(), errorMessage: null, autoPausedReason: null },
        });
        if (!moved.count) throw new ConflictException('A campanha já foi iniciada');

        const created: Array<{ id: string; scheduledFor: Date }> = [];
        let batchIndex = 0; // único na campanha, contínuo entre os chips
        for (const chip of plans) {
          const chipRecipients = chip.recipientIndexes.map((ix) => valid[ix].id);
          let offset = 0;
          for (const p of chip.plan.batches) {
            const row = await tx.campaignBatch.create({
              data: {
                campaignId: id,
                channelId: chip.channelId,
                batchIndex: batchIndex++,
                scheduledFor: p.scheduledFor,
                recipientCount: p.size,
              },
            });
            await tx.campaignRecipient.updateMany({
              where: { id: { in: chipRecipients.slice(offset, offset + p.size) } },
              data: { batchId: row.id, channelId: chip.channelId },
            });
            offset += p.size;
            created.push(row);
          }
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
      batches: summary.batches,
      chips: chips.length,
      effectiveDailyCap: summary.effectiveDailyCap,
      capLimitedByWindow: summary.capLimitedByWindow,
      estimatedEnd: summary.estimatedEnd,
    };
  }

  /**
   * Nenhum chip pode estar em outra campanha ativa. A trava consultiva (ordenada, para não gerar deadlock
   * entre inícios concorrentes) serializa quem disputa o mesmo canal; a contagem roda já com a trava.
   */
  private async assertChipsFree(tx: Prisma.TransactionClient, campaignId: string, chips: Array<{ id: string; name: string }>) {
    for (const c of [...chips].sort((a, b) => a.id.localeCompare(b.id))) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${c.id}))`;
    }
    const busy = await tx.campaignChannel.findFirst({
      where: {
        channelId: { in: chips.map((c) => c.id) },
        campaignId: { not: campaignId },
        campaign: { deletedAt: null, status: { in: [...ACTIVE_CAMPAIGN_STATUSES] } },
      },
      select: { channel: { select: { name: true } } },
    });
    if (busy) {
      throw new ConflictException(
        `O canal "${busy.channel.name}" já está em uma campanha ativa. Finalize ou cancele a anterior`,
      );
    }
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

  /** Gera um novo segredo de assinatura; o valor só é devolvido aqui. */
  async rotateWebhookSecret(orgId: string, id: string, access: ChannelAccess) {
    const campaign = await this.getOwned(orgId, id, access);
    if (!campaign.onReplyWebhookUrl) throw new ConflictException('Configure a URL do webhook antes de gerar o segredo');
    const secret = newWebhookSecret();
    await this.prisma.campaign.update({ where: { id }, data: { onReplyWebhookSecret: secret } });
    return { webhookSecret: secret };
  }

  /** Dispara um evento de teste assinado para a URL configurada (diagnóstico). */
  async testWebhook(orgId: string, id: string, access: ChannelAccess) {
    const campaign = await this.getOwned(orgId, id, access);
    if (!campaign.onReplyWebhookUrl || !campaign.onReplyWebhookSecret) {
      throw new ConflictException('Configure a URL do webhook antes de testar');
    }
    return this.replyWebhook.sendTest(campaign);
  }
}
