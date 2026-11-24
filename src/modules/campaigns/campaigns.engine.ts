import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Channel, Campaign, CampaignBatch, CampaignRecipient, Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../../database/prisma.service';
import { ChannelAdapterRegistry } from '../channel-hub/channel-adapter.registry';
import { BulkSenderPort } from '../channel-hub/ports/bulk-sender.port';
import { ContactProvisioningService } from '../channel-hub/utils/contact-provisioning.service';
import { phoneMatchKey, stripWhatsappJid } from '../channel-hub/utils/whatsapp-jid';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { planBatches, getZonedParts, zonedToUtc, parseHm } from './batching/campaign-batch-planner';
import { renderCampaignText } from './campaign-text';
import { CAMPAIGNS_QUEUE, CAMPAIGN_JOBS, CAMPAIGN_LIMITS } from './campaigns.constants';

export interface CampaignStats {
  total: number;
  valid: number;
  invalid: number;
  duplicate: number;
  notOnWhatsapp: number;
  optedOut: number;
  queued: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  cancelled: number;
  replied: number;
}

type CampaignWithChannel = Campaign & { channel: Channel; organization?: { aiTimezone: string | null } };

const JOB_OPTS = { removeOnComplete: true, removeOnFail: true } as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const digits = (s: string) => s.replace(/\D/g, '');
const chunk = <T>(arr: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

/**
 * Lógica de execução das campanhas (chamada pelo processor das filas e pelo
 * service HTTP). Nenhum envio é feito por nós: delegamos a pasta à fila nativa
 * do provider e só planejamos, submetemos, acompanhamos e reconciliamos.
 */
@Injectable()
export class CampaignsEngine {
  private readonly logger = new Logger(CampaignsEngine.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly realtime: RealtimeGateway,
    private readonly provisioning: ContactProvisioningService,
    @InjectQueue(CAMPAIGNS_QUEUE) private readonly queue: Queue,
  ) {}

  // ─── Helpers ───────────────────────────────────────────────────────

  bulkFor(channel: Channel): BulkSenderPort {
    const bulk = this.registry.getBulkSender(channel.type);
    if (!bulk) throw new UnprocessableEntityException('Este canal não suporta envio em massa');
    return bulk;
  }

  private async loadCampaign(id: string): Promise<CampaignWithChannel | null> {
    return this.prisma.campaign.findFirst({
      where: { id, deletedAt: null },
      include: { channel: true, organization: { select: { aiTimezone: true } } },
    });
  }

  private tz(c: CampaignWithChannel): string {
    return c.organization?.aiTimezone || 'America/Sao_Paulo';
  }

  async computeStats(campaignId: string): Promise<CampaignStats> {
    const [groups, replied] = await Promise.all([
      this.prisma.campaignRecipient.groupBy({
        by: ['status'],
        where: { campaignId },
        _count: { _all: true },
      }),
      this.prisma.campaignRecipient.count({ where: { campaignId, repliedAt: { not: null } } }),
    ]);
    const n: Record<string, number> = {};
    let total = 0;
    for (const g of groups) {
      n[g.status] = g._count._all;
      total += g._count._all;
    }
    const g = (k: string) => n[k] ?? 0;
    // sent/delivered/read são cumulativos (entregue implica enviado).
    return {
      total,
      valid: g('VALID') + g('QUEUED') + g('SENT') + g('DELIVERED') + g('READ') + g('FAILED') + g('CANCELLED'),
      invalid: g('INVALID'),
      duplicate: g('DUPLICATE'),
      notOnWhatsapp: g('NOT_ON_WHATSAPP'),
      optedOut: g('OPTED_OUT'),
      queued: g('QUEUED'),
      sent: g('SENT') + g('DELIVERED') + g('READ'),
      delivered: g('DELIVERED') + g('READ'),
      read: g('READ'),
      failed: g('FAILED'),
      cancelled: g('CANCELLED'),
      replied,
    };
  }

  async emitProgress(campaignId: string): Promise<CampaignStats> {
    const stats = await this.computeStats(campaignId);
    const campaign = await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { stats: stats as unknown as Prisma.InputJsonValue },
      select: { id: true, organizationId: true, status: true, autoPausedReason: true },
    });
    this.realtime.emitToOrg(campaign.organizationId, 'campaign:progress', {
      campaignId,
      status: campaign.status,
      autoPausedReason: campaign.autoPausedReason,
      stats,
    });
    return stats;
  }

  /** Contatos da org que fizeram opt-out (por telefone ou JID). Retorna E.164. */
  async findOptedOut(organizationId: string, phones: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    for (const part of chunk(phones, 1000)) {
      const variants = part.flatMap((p) => [p, `+${p}`]);
      const jids = part.map((p) => `${p}@s.whatsapp.net`);
      const [byPhone, byChannel] = await Promise.all([
        this.prisma.contact.findMany({
          where: {
            organizationId,
            deletedAt: null,
            marketingOptOutAt: { not: null },
            phone: { in: variants },
          },
          select: { phone: true },
        }),
        this.prisma.contactChannel.findMany({
          where: {
            externalId: { in: [...jids, ...part] },
            contact: { organizationId, deletedAt: null, marketingOptOutAt: { not: null } },
          },
          select: { externalId: true },
        }),
      ]);
      for (const c of byPhone) if (c.phone) out.add(digits(c.phone));
      for (const c of byChannel) out.add(digits(stripWhatsappJid(c.externalId)));
    }
    return out;
  }

  // ─── Agendamento de jobs ───────────────────────────────────────────

  async scheduleSubmit(campaignId: string, batch: { id: string; scheduledFor: Date }): Promise<void> {
    // Submissão preguiçosa 10 min antes da janela: opt-out e pausas valem para lotes futuros.
    const delay = Math.max(0, batch.scheduledFor.getTime() - Date.now() - 10 * 60_000);
    await this.queue.add(
      CAMPAIGN_JOBS.SUBMIT_BATCH,
      { campaignId, batchId: batch.id },
      {
        delay,
        jobId: `batch-${batch.id}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 10_000 },
        ...JOB_OPTS,
      },
    );
  }

  async scheduleReconcile(campaignId: string, delayMs: number = CAMPAIGN_LIMITS.reconcileIntervalMs): Promise<void> {
    await this.queue.add(
      CAMPAIGN_JOBS.RECONCILE,
      { campaignId, chain: true },
      {
        delay: delayMs,
        jobId: `reconcile-${campaignId}-${Math.floor((Date.now() + delayMs) / 60_000)}`,
        ...JOB_OPTS,
      },
    );
  }

  private async scheduleGuard(campaignId: string, batchId: string, guardAt: Date): Promise<void> {
    await this.queue.add(
      CAMPAIGN_JOBS.WINDOW_GUARD,
      { campaignId, batchId },
      { delay: Math.max(0, guardAt.getTime() - Date.now()), jobId: `guard-${batchId}`, ...JOB_OPTS },
    );
  }

  // ─── validate-numbers ──────────────────────────────────────────────

  async validateNumbers(campaignId: string): Promise<void> {
    const campaign = await this.loadCampaign(campaignId);
    if (!campaign) return;
    const bulk = this.bulkFor(campaign.channel);

    try {
      for (;;) {
        // Cancelamento entre lotes.
        const fresh = await this.prisma.campaign.findUnique({ where: { id: campaignId }, select: { status: true } });
        if (!fresh || fresh.status !== 'VALIDATING') return;

        const pending = await this.prisma.campaignRecipient.findMany({
          where: { campaignId, status: 'PENDING' },
          orderBy: { rowNumber: 'asc' },
          take: CAMPAIGN_LIMITS.checkBatchSize,
          select: { id: true, phoneE164: true },
        });
        if (!pending.length) break;

        const results = await bulk.checkNumbers(
          campaign.channel,
          pending.map((p) => p.phoneE164!),
        );
        const byQuery = new Map(results.map((r) => [digits(r.query), r]));
        // Fallback: se o provider devolveu o mesmo nº de itens mas formatou o "query"
        // diferente, casa por posição em vez de marcar todo mundo "sem WhatsApp".
        const byIndex = results.length === pending.length && !pending.some((p) => byQuery.has(p.phoneE164!));

        await this.prisma.$transaction(
          pending.map((p) => {
            const r = byQuery.get(p.phoneE164!) ?? (byIndex ? results[pending.indexOf(p)] : undefined);
            if (r && r.isInWhatsapp && r.jid) {
              return this.prisma.campaignRecipient.update({
                where: { id: p.id },
                data: { status: 'VALID', jid: r.jid },
              });
            }
            return this.prisma.campaignRecipient.update({
              where: { id: p.id },
              data: { status: 'NOT_ON_WHATSAPP' },
            });
          }),
        );
        await this.emitProgress(campaignId);
        await sleep(200); // ≤ ~5 req/s (limite do token: 10/s)
      }

      await this.prisma.campaign.updateMany({
        where: { id: campaignId, status: 'VALIDATING' },
        data: { status: 'READY' },
      });
      await this.emitProgress(campaignId);
    } catch (err: any) {
      this.logger.error(`validate-numbers falhou (${campaignId}): ${err.message}`);
      await this.prisma.campaign.updateMany({
        where: { id: campaignId, status: 'VALIDATING' },
        data: { status: 'FAILED', errorMessage: `Falha ao validar números: ${err.message}` },
      });
      await this.emitProgress(campaignId);
      throw err;
    }
  }

  // ─── submit-batch ──────────────────────────────────────────────────

  private nextWindowStart(c: CampaignWithChannel, notBefore: Date): Date {
    const plan = planBatches({
      recipientCount: 1,
      dailyCap: 1,
      windowStart: c.sendWindowStart,
      windowEnd: c.sendWindowEnd,
      weekdays: c.sendWeekdays,
      timezone: this.tz(c),
      delayMinSec: c.delayMinSec,
      delayMaxSec: c.delayMaxSec,
      notBefore,
    });
    return plan.batches[0].scheduledFor;
  }

  async submitBatch(campaignId: string, batchId: string): Promise<{ skipped?: string; folderId?: string }> {
    const campaign = await this.loadCampaign(campaignId);
    const batch = await this.prisma.campaignBatch.findUnique({ where: { id: batchId } });
    if (!campaign || !batch || batch.campaignId !== campaignId) return { skipped: 'not_found' };
    if (!['SUBMITTING', 'SCHEDULED', 'RUNNING'].includes(campaign.status)) return { skipped: 'campaign_not_active' };
    if (!['PLANNED', 'SUBMITTING'].includes(batch.status)) return { skipped: 'batch_not_pending' };

    // Lote anterior ainda ativo → o window-guard o fecha no fim da janela; tenta de novo depois.
    if (batch.batchIndex > 0) {
      const prev = await this.prisma.campaignBatch.findFirst({
        where: { campaignId, batchIndex: { lt: batch.batchIndex }, status: { in: ['SUBMITTING', 'SCHEDULED', 'RUNNING'] } },
        select: { id: true },
      });
      if (prev) {
        await this.queue.add(
          CAMPAIGN_JOBS.SUBMIT_BATCH,
          { campaignId, batchId },
          { delay: 30 * 60_000, jobId: `batch-${batchId}-r${Date.now()}`, attempts: 3, ...JOB_OPTS },
        );
        return { skipped: 'previous_batch_active' };
      }
    }

    // Início real respeita janela/dias, mesmo se a submissão atrasou (resume, retry…).
    const startAt = this.nextWindowStart(campaign, new Date(Math.max(Date.now(), batch.scheduledFor.getTime())));

    // Recheck de opt-out (de qualquer campanha da org) desde o import.
    const recipients = await this.prisma.campaignRecipient.findMany({
      where: { batchId, status: { in: ['VALID', 'QUEUED'] } },
      orderBy: { rowNumber: 'asc' },
    });
    const optedOut = await this.findOptedOut(
      campaign.organizationId,
      recipients.map((r) => r.phoneE164!).filter(Boolean),
    );
    const optedIds = recipients.filter((r) => optedOut.has(r.phoneE164!)).map((r) => r.id);
    if (optedIds.length) {
      await this.prisma.campaignRecipient.updateMany({
        where: { id: { in: optedIds } },
        data: { status: 'OPTED_OUT' },
      });
    }
    const sendable = recipients.filter((r) => !optedOut.has(r.phoneE164!));

    if (!sendable.length) {
      await this.prisma.campaignBatch.update({
        where: { id: batchId },
        data: { status: 'DONE', completedAt: new Date(), recipientCount: 0 },
      });
      await this.afterBatchDone(campaignId);
      return { skipped: 'empty_batch' };
    }

    await this.prisma.campaignBatch.update({
      where: { id: batchId },
      data: { status: 'SUBMITTING', scheduledFor: startAt },
    });

    // Contatos + texto final persistidos ANTES de chamar o provider (o echo precisa casar).
    const prepared = new Map<string, { contactId: string; rendered: string }>();
    for (const part of chunk(sendable, 10)) {
      await Promise.all(
        part.map(async (r) => {
          const p = await this.provisioning.provision(
            campaign.organizationId,
            campaign.channelId,
            campaign.channel.type,
            {
              phone: r.phoneE164!,
              name: r.companyName || null,
              metadata: { companyName: r.companyName },
              externalId: r.jid ?? undefined,
            },
          );
          prepared.set(r.id, {
            contactId: p.contactId,
            rendered: renderCampaignText(r.messageText, r.companyName, campaign.appendOptOutFooter),
          });
        }),
      );
    }
    for (const part of chunk(sendable, 100)) {
      await this.prisma.$transaction(
        part.map((r) =>
          this.prisma.campaignRecipient.update({
            where: { id: r.id },
            data: { contactId: prepared.get(r.id)!.contactId, renderedText: prepared.get(r.id)!.rendered },
          }),
        ),
      );
    }

    // Idempotência: antes de criar, procura pasta já criada para este lote (timeout + retry).
    const bulk = this.bulkFor(campaign.channel);
    const info = `ic:${campaignId}:${batch.batchIndex}`;
    let folderId = batch.providerFolderId ?? undefined;
    if (!folderId) {
      const existing = (await bulk.listFolders(campaign.channel)).find((f) => f.info === info);
      folderId = existing?.folderId;
    }
    if (!folderId) {
      const created = await bulk.createFolder(campaign.channel, {
        messages: sendable.map((r) => ({
          number: stripWhatsappJid(r.jid ?? r.phoneE164!),
          text: prepared.get(r.id)!.rendered,
        })),
        delayMinSec: campaign.delayMinSec,
        delayMaxSec: campaign.delayMaxSec,
        info,
        scheduledFor: Math.max(startAt.getTime(), Date.now() + 5_000),
      });
      folderId = created.folderId;
    }

    // Pausa/cancelamento podem ter acontecido DURANTE a chamada ao provider. Grava o folderId
    // sempre (idempotência), mas só promove o lote se ele ainda está SUBMITTING.
    const [promoted] = await this.prisma.$transaction([
      this.prisma.campaignBatch.updateMany({
        where: { id: batchId, status: 'SUBMITTING' },
        data: { providerFolderId: folderId, status: 'SCHEDULED', submittedAt: new Date(), recipientCount: sendable.length },
      }),
      this.prisma.campaignBatch.updateMany({
        where: { id: batchId, status: { not: 'SUBMITTING' }, providerFolderId: null },
        data: { providerFolderId: folderId },
      }),
    ]);
    const after = await this.prisma.campaign.findUnique({ where: { id: campaignId }, select: { status: true } });
    if (!promoted.count || !after || !['SUBMITTING', 'SCHEDULED', 'RUNNING'].includes(after.status)) {
      try {
        await bulk.controlFolder(campaign.channel, folderId, 'stop');
      } catch (err: any) {
        this.logger.warn(`stop da pasta ${folderId} (corrida com pausa/cancelamento) falhou: ${err.message}`);
      }
      if (after?.status === 'PAUSED' && promoted.count) {
        // Pausada no meio: o lote fica SCHEDULED com pasta parada; o resume faz o continue.
        await this.prisma.campaignRecipient.updateMany({
          where: { id: { in: sendable.map((r) => r.id) }, status: 'VALID' },
          data: { status: 'QUEUED' },
        });
      }
      return { skipped: 'stopped_during_submit', folderId };
    }
    await this.prisma.$transaction([
      this.prisma.campaignRecipient.updateMany({
        where: { id: { in: sendable.map((r) => r.id) }, status: 'VALID' },
        data: { status: 'QUEUED' },
      }),
      this.prisma.campaign.updateMany({
        where: { id: campaignId, status: 'SUBMITTING' },
        data: { status: 'SCHEDULED' },
      }),
    ]);

    // Corte da janela: se sobrar mensagem no fim do dia, para a pasta e adia o resto.
    const z = getZonedParts(startAt, this.tz(campaign));
    const guardAt = zonedToUtc(z.year, z.month, z.day, parseHm(campaign.sendWindowEnd), this.tz(campaign));
    await this.scheduleGuard(campaignId, batchId, guardAt);
    await this.scheduleReconcile(campaignId, 15_000);
    await this.emitProgress(campaignId);
    return { folderId };
  }

  // ─── window-guard / carry-over ─────────────────────────────────────

  /** Fecha o lote: para a pasta, reconcilia e devolve o que sobrou para o próximo lote. */
  async finalizeBatch(campaignId: string, batchId: string): Promise<void> {
    const campaign = await this.loadCampaign(campaignId);
    const batch = await this.prisma.campaignBatch.findUnique({ where: { id: batchId } });
    if (!campaign || !batch || !['SCHEDULED', 'RUNNING'].includes(batch.status)) return;

    if (batch.providerFolderId) {
      try {
        await this.bulkFor(campaign.channel).controlFolder(campaign.channel, batch.providerFolderId, 'stop');
      } catch (err: any) {
        this.logger.warn(`stop da pasta ${batch.providerFolderId} falhou: ${err.message}`);
      }
    }
    await this.reconcileCampaign(campaignId, { forceBatchIds: [batchId] });

    const leftovers = await this.prisma.campaignRecipient.findMany({
      where: { batchId, status: 'QUEUED' },
      select: { id: true },
    });
    // Ordem importa: o lote de sobra (PLANNED) precisa existir ANTES de este virar DONE,
    // senão um reconcile concorrente vê "nenhum lote aberto" e conclui a campanha.
    if (leftovers.length && ['SCHEDULED', 'RUNNING'].includes(campaign.status)) {
      await this.carryOver(campaign, leftovers.map((l) => l.id));
    }
    await this.prisma.campaignBatch.update({
      where: { id: batchId },
      data: { status: 'DONE', completedAt: new Date() },
    });
    await this.afterBatchDone(campaignId);
  }

  private async carryOver(campaign: CampaignWithChannel, recipientIds: string[]): Promise<void> {
    const next = await this.prisma.campaignBatch.findFirst({
      where: { campaignId: campaign.id, status: 'PLANNED' },
      orderBy: { batchIndex: 'asc' },
    });
    await this.prisma.campaignRecipient.updateMany({
      where: { id: { in: recipientIds } },
      data: { status: 'VALID', batchId: next?.id ?? null, providerMessageId: null },
    });
    if (next) {
      await this.prisma.campaignBatch.update({
        where: { id: next.id },
        data: { recipientCount: { increment: recipientIds.length } },
      });
      return;
    }
    const last = await this.prisma.campaignBatch.findFirst({
      where: { campaignId: campaign.id },
      orderBy: { batchIndex: 'desc' },
      select: { batchIndex: true },
    });
    const plan = planBatches({
      recipientCount: recipientIds.length,
      dailyCap: campaign.dailyCap,
      windowStart: campaign.sendWindowStart,
      windowEnd: campaign.sendWindowEnd,
      weekdays: campaign.sendWeekdays,
      timezone: this.tz(campaign),
      delayMinSec: campaign.delayMinSec,
      delayMaxSec: campaign.delayMaxSec,
      notBefore: new Date(),
    });
    let offset = 0;
    for (const p of plan.batches) {
      const row = await this.prisma.campaignBatch.create({
        data: {
          campaignId: campaign.id,
          batchIndex: (last?.batchIndex ?? -1) + 1 + p.batchIndex,
          scheduledFor: p.scheduledFor,
          recipientCount: p.size,
        },
      });
      await this.prisma.campaignRecipient.updateMany({
        where: { id: { in: recipientIds.slice(offset, offset + p.size) } },
        data: { batchId: row.id },
      });
      offset += p.size;
      await this.scheduleSubmit(campaign.id, row);
    }
  }

  async afterBatchDone(campaignId: string): Promise<void> {
    const open = await this.prisma.campaignBatch.count({
      where: { campaignId, status: { in: ['PLANNED', 'SUBMITTING', 'SCHEDULED', 'RUNNING'] } },
    });
    if (open === 0) {
      await this.prisma.campaign.updateMany({
        where: { id: campaignId, status: { in: ['SUBMITTING', 'SCHEDULED', 'RUNNING'] } },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
    }
    await this.emitProgress(campaignId);
  }

  // ─── reconcile ─────────────────────────────────────────────────────

  async reconcileCampaign(
    campaignId: string,
    opts: { chain?: boolean; forceBatchIds?: string[] } = {},
  ): Promise<void> {
    const campaign = await this.loadCampaign(campaignId);
    if (!campaign) return;
    const active = ['SUBMITTING', 'SCHEDULED', 'RUNNING'].includes(campaign.status);
    if (!active && !opts.forceBatchIds) return;

    const bulk = this.bulkFor(campaign.channel);

    if (active && !opts.forceBatchIds) {
      const connected = await bulk.isConnected(campaign.channel).catch(() => true);
      if (!connected) {
        await this.pauseCampaign(campaignId, 'CHANNEL_DISCONNECTED');
        return;
      }
    }

    const batches = await this.prisma.campaignBatch.findMany({
      where: {
        campaignId,
        providerFolderId: { not: null },
        OR: [{ status: { in: ['SCHEDULED', 'RUNNING'] } }, ...(opts.forceBatchIds ? [{ id: { in: opts.forceBatchIds } }] : [])],
      },
    });

    let folders = new Map<string, { status?: string; sent?: number }>();
    try {
      folders = new Map((await bulk.listFolders(campaign.channel)).map((f) => [f.folderId, f]));
    } catch (err: any) {
      this.logger.warn(`listFolders falhou (${campaignId}): ${err.message}`);
    }

    for (const batch of batches) {
      try {
        await this.reconcileBatch(campaign, batch, folders.get(batch.providerFolderId!));
      } catch (err: any) {
        this.logger.warn(`reconcile do lote ${batch.id} falhou: ${err.message}`);
      }
    }

    const stats = await this.emitProgress(campaignId);
    const attempted = stats.sent + stats.failed;
    if (
      active &&
      attempted >= CAMPAIGN_LIMITS.autoPauseMinSample &&
      (stats.failed / attempted) * 100 > campaign.maxFailureRatePct
    ) {
      await this.pauseCampaign(campaignId, 'FAILURE_RATE');
      return;
    }
    await this.afterBatchDone(campaignId);

    if (opts.chain) {
      const still = await this.prisma.campaign.findUnique({ where: { id: campaignId }, select: { status: true } });
      if (still && ['SUBMITTING', 'SCHEDULED', 'RUNNING'].includes(still.status)) {
        await this.scheduleReconcile(campaignId);
      }
    }
  }

  private async reconcileBatch(
    campaign: CampaignWithChannel,
    batch: CampaignBatch,
    folder: { status?: string; sent?: number } | undefined,
  ): Promise<void> {
    const bulk = this.bulkFor(campaign.channel);
    const recipients = await this.prisma.campaignRecipient.findMany({
      where: { batchId: batch.id, status: { in: ['QUEUED', 'SENT', 'DELIVERED', 'READ'] } },
    });
    // phoneMatchKey: o chatid devolvido pelo WhatsApp pode vir sem o 9º dígito do celular BR.
    const byNumber = new Map<string, CampaignRecipient>();
    for (const r of recipients) byNumber.set(phoneMatchKey(r.jid ?? r.phoneE164 ?? ''), r);

    let offset = 0;
    let anySent = false;
    for (;;) {
      const page = await bulk.listFolderMessages(campaign.channel, batch.providerFolderId!, { limit: 1000, offset });
      for (const m of page.messages) {
        const r = byNumber.get(phoneMatchKey(m.chatId));
        if (!r) continue;
        if (['SENT', 'DELIVERED', 'READ'].includes(m.status)) anySent = true;
        const data: Prisma.CampaignRecipientUpdateInput = {};
        if (m.providerMessageId && !r.providerMessageId) data.providerMessageId = m.providerMessageId;
        if (m.status === 'FAILED' && r.status === 'QUEUED') {
          data.status = 'FAILED';
          data.error = (m.error ?? 'Falha no envio').slice(0, 500);
        } else if (['SENT', 'DELIVERED', 'READ'].includes(m.status)) {
          // Preenche eventos perdidos (webhook) sem nunca regredir: QUEUED < SENT < DELIVERED < READ.
          const rank: Record<string, number> = { QUEUED: 0, SENT: 1, DELIVERED: 2, READ: 3 };
          if ((rank[m.status] ?? 0) > (rank[r.status] ?? 0)) {
            const now = new Date();
            data.status = m.status as 'SENT' | 'DELIVERED' | 'READ';
            data.sentAt = r.sentAt ?? now;
            if (m.status !== 'SENT') data.deliveredAt = r.deliveredAt ?? now;
            if (m.status === 'READ') data.readAt = r.readAt ?? now;
          }
        }
        if (Object.keys(data).length) {
          await this.prisma.campaignRecipient.update({ where: { id: r.id }, data });
        }
      }
      if (!page.hasMore) break;
      offset += 1000;
    }

    const fStatus = String(folder?.status ?? '').toLowerCase();
    const done = ['done', 'completed', 'finished'].includes(fStatus);
    if (done) {
      await this.prisma.campaignBatch.updateMany({
        where: { id: batch.id, status: { in: ['SCHEDULED', 'RUNNING'] } },
        data: { status: 'DONE', completedAt: new Date() },
      });
    } else if (anySent || ['sending', 'running'].includes(fStatus)) {
      await this.prisma.campaignBatch.updateMany({ where: { id: batch.id, status: 'SCHEDULED' }, data: { status: 'RUNNING' } });
      await this.prisma.campaign.updateMany({ where: { id: campaign.id, status: 'SCHEDULED' }, data: { status: 'RUNNING' } });
    }
  }

  async handleSenderEvent(channelId: string, event: { folderId: string; status: string }): Promise<void> {
    const batch = await this.prisma.campaignBatch.findFirst({
      where: { providerFolderId: event.folderId, campaign: { channelId, deletedAt: null } },
      select: { id: true, campaignId: true },
    });
    if (!batch) return;
    if (event.status === 'sending') {
      await this.prisma.campaignBatch.updateMany({ where: { id: batch.id, status: 'SCHEDULED' }, data: { status: 'RUNNING' } });
      await this.prisma.campaign.updateMany({ where: { id: batch.campaignId, status: 'SCHEDULED' }, data: { status: 'RUNNING' } });
    }
    await this.reconcileCampaign(batch.campaignId);
  }

  // ─── Controles ─────────────────────────────────────────────────────

  async pauseCampaign(campaignId: string, autoReason: string | null): Promise<void> {
    const campaign = await this.loadCampaign(campaignId);
    if (!campaign) throw new NotFoundException('Campanha não encontrada');
    const bulk = this.bulkFor(campaign.channel);

    const moved = await this.prisma.campaign.updateMany({
      where: { id: campaignId, status: { in: ['SUBMITTING', 'SCHEDULED', 'RUNNING'] } },
      data: { status: 'PAUSED', autoPausedReason: autoReason },
    });
    if (!moved.count) return;

    const batches = await this.prisma.campaignBatch.findMany({
      where: { campaignId, status: { in: ['SCHEDULED', 'RUNNING'] }, providerFolderId: { not: null } },
    });
    for (const b of batches) {
      try {
        await bulk.controlFolder(campaign.channel, b.providerFolderId!, 'stop');
      } catch (err: any) {
        this.logger.warn(`stop da pasta ${b.providerFolderId} falhou: ${err.message}`);
      }
    }
    await this.emitProgress(campaignId);
    if (autoReason) {
      this.realtime.emitToOrg(campaign.organizationId, 'campaign:auto-paused', { campaignId, reason: autoReason });
    }
  }

  async resumeCampaign(campaignId: string): Promise<void> {
    const campaign = await this.loadCampaign(campaignId);
    if (!campaign) throw new NotFoundException('Campanha não encontrada');
    const bulk = this.bulkFor(campaign.channel);

    const batches = await this.prisma.campaignBatch.findMany({
      where: { campaignId, status: { in: ['PLANNED', 'SUBMITTING', 'SCHEDULED', 'RUNNING'] } },
      orderBy: { batchIndex: 'asc' },
    });
    const anyStarted = batches.some((b) => b.status === 'RUNNING');
    const moved = await this.prisma.campaign.updateMany({
      where: { id: campaignId, status: 'PAUSED' },
      data: { status: anyStarted ? 'RUNNING' : 'SCHEDULED', autoPausedReason: null },
    });
    if (!moved.count) return;

    const tz = this.tz(campaign);
    for (const b of batches) {
      if (b.providerFolderId && ['SCHEDULED', 'RUNNING'].includes(b.status)) {
        // Pasta já na UaZAPI: dentro da janela, continua; fora, fecha o dia e adia o resto.
        const nowStart = this.nextWindowStart(campaign, new Date());
        const insideWindow = Math.abs(nowStart.getTime() - Date.now()) < 60_000;
        if (insideWindow) {
          try {
            await bulk.controlFolder(campaign.channel, b.providerFolderId, 'continue');
          } catch (err: any) {
            this.logger.warn(`continue da pasta ${b.providerFolderId} falhou: ${err.message}`);
          }
          const z = getZonedParts(new Date(), tz);
          await this.scheduleGuard(campaignId, b.id, zonedToUtc(z.year, z.month, z.day, parseHm(campaign.sendWindowEnd), tz));
        } else {
          await this.finalizeBatch(campaignId, b.id);
        }
      } else if (['PLANNED', 'SUBMITTING'].includes(b.status)) {
        await this.scheduleSubmit(campaignId, b);
      }
    }
    await this.scheduleReconcile(campaignId, 5_000);
    await this.emitProgress(campaignId);
  }

  async cancelCampaign(campaignId: string): Promise<void> {
    const campaign = await this.loadCampaign(campaignId);
    if (!campaign) throw new NotFoundException('Campanha não encontrada');
    const bulk = this.bulkFor(campaign.channel);

    const moved = await this.prisma.campaign.updateMany({
      where: { id: campaignId, status: { in: ['DRAFT', 'VALIDATING', 'READY', 'SUBMITTING', 'SCHEDULED', 'RUNNING', 'PAUSED'] } },
      data: { status: 'CANCELLED', completedAt: new Date() },
    });
    if (!moved.count) return;

    const batches = await this.prisma.campaignBatch.findMany({
      where: { campaignId, status: { in: ['PLANNED', 'SUBMITTING', 'SCHEDULED', 'RUNNING'] } },
    });
    for (const b of batches) {
      if (b.providerFolderId) {
        try {
          await bulk.controlFolder(campaign.channel, b.providerFolderId, 'stop');
        } catch (err: any) {
          this.logger.warn(`stop da pasta ${b.providerFolderId} falhou: ${err.message}`);
        }
      }
      await this.queue.remove(`batch-${b.id}`).catch(() => undefined);
      await this.queue.remove(`guard-${b.id}`).catch(() => undefined);
    }
    await this.prisma.campaignBatch.updateMany({
      where: { campaignId, status: { in: ['PLANNED', 'SUBMITTING', 'SCHEDULED', 'RUNNING'] } },
      data: { status: 'CANCELLED', completedAt: new Date() },
    });
    // O que o provider não enviou nunca mais será enviado.
    await this.reconcileCampaign(campaignId, { forceBatchIds: batches.map((b) => b.id) });
    await this.prisma.campaignRecipient.updateMany({
      where: { campaignId, status: { in: ['PENDING', 'VALID', 'QUEUED'] } },
      data: { status: 'CANCELLED' },
    });
    await this.emitProgress(campaignId);
  }

  async sendNow(campaignId: string): Promise<number> {
    const campaign = await this.loadCampaign(campaignId);
    if (!campaign) throw new NotFoundException('Campanha não encontrada');
    const bulk = this.bulkFor(campaign.channel);

    // Lotes ainda não entregues ao provider (a submissão é preguiçosa: 10 min antes da janela)
    // são submetidos agora; em seguida o send_now antecipa a pasta já criada.
    // Inclui SUBMITTING sem pasta: tentativa anterior que falhou (ex.: canal offline) e ficou parada.
    const planned = await this.prisma.campaignBatch.findMany({
      where: {
        campaignId,
        OR: [{ status: 'PLANNED' }, { status: 'SUBMITTING', providerFolderId: null }],
      },
      orderBy: { batchIndex: 'asc' },
      select: { id: true },
    });
    for (const b of planned) await this.submitBatch(campaignId, b.id);

    const batches = await this.prisma.campaignBatch.findMany({
      where: { campaignId, status: 'SCHEDULED', providerFolderId: { not: null } },
    });
    for (const b of batches) await bulk.controlFolder(campaign.channel, b.providerFolderId!, 'send_now');
    await this.scheduleReconcile(campaignId, 5_000);
    return batches.length;
  }
}
