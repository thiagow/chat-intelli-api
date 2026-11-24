import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../database/prisma.service';
import { CampaignsEngine } from './campaigns.engine';
import { CAMPAIGNS_QUEUE, CAMPAIGN_JOBS } from './campaigns.constants';
import { PermanentWebhookError, ReplyWebhookService } from './reply-webhook.service';

@Processor(CAMPAIGNS_QUEUE, { concurrency: 5 })
export class CampaignsProcessor extends WorkerHost {
  private readonly logger = new Logger(CampaignsProcessor.name);

  constructor(
    private readonly engine: CampaignsEngine,
    private readonly prisma: PrismaService,
    private readonly replyWebhook: ReplyWebhookService,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case CAMPAIGN_JOBS.VALIDATE_NUMBERS:
        return this.engine.validateNumbers(job.data.campaignId);
      case CAMPAIGN_JOBS.SUBMIT_BATCH:
        return this.engine.submitBatch(job.data.campaignId, job.data.batchId);
      case CAMPAIGN_JOBS.WINDOW_GUARD:
        return this.engine.finalizeBatch(job.data.campaignId, job.data.batchId);
      case CAMPAIGN_JOBS.RECONCILE:
        return this.engine.reconcileCampaign(job.data.campaignId, { chain: job.data.chain !== false });
      case CAMPAIGN_JOBS.SENDER_EVENT:
        return this.engine.handleSenderEvent(job.data.channelId, job.data.event);
      case CAMPAIGN_JOBS.REPLY_WEBHOOK:
        try {
          return await this.replyWebhook.deliver(job.data);
        } catch (err) {
          // Falha definitiva: não adianta tentar de novo (URL bloqueada, 4xx).
          if (err instanceof PermanentWebhookError) {
            await this.replyWebhook.markFailed(job.data.recipientId, err.message);
            this.logger.warn(`reply-webhook definitivo ${job.data.recipientId}: ${err.message}`);
            return { skipped: 'permanent', reason: err.message };
          }
          throw err;
        }
      default:
        this.logger.warn(`Job desconhecido na fila de campanhas: ${job.name}`);
        return null;
    }
  }

  /**
   * Esgotou as tentativas de submissão: o lote volta para PLANNED e a campanha
   * pausa com o motivo — nada de pasta duplicada, e o operador retoma manualmente.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, err: Error): Promise<void> {
    if (!job) return;
    if (job.name === CAMPAIGN_JOBS.REPLY_WEBHOOK) {
      if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
        await this.replyWebhook.markFailed(job.data.recipientId, err.message);
        this.logger.error(`reply-webhook esgotou tentativas (${job.data.recipientId}): ${err.message}`);
      }
      return;
    }
    if (job.name !== CAMPAIGN_JOBS.SUBMIT_BATCH) return;
    if (job.attemptsMade < (job.opts.attempts ?? 1)) return;
    this.logger.error(`submit-batch esgotou tentativas (batch ${job.data.batchId}): ${err.message}`);
    try {
      await this.prisma.campaignBatch.updateMany({
        where: { id: job.data.batchId, status: 'SUBMITTING' },
        data: { status: 'PLANNED' },
      });
      await this.engine.pauseCampaign(job.data.campaignId, `SUBMIT_FAILED: ${err.message}`.slice(0, 200));
    } catch (e: any) {
      this.logger.error(`Falha ao pausar campanha após erro de submissão: ${e.message}`);
    }
  }
}
