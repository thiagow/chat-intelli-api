import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { safePost, UnsafeUrlError } from '../../common/net/safe-fetch';

export const REPLY_WEBHOOK_EVENT = 'campaign.reply';

/** Falha definitiva (sem retry): URL insegura/removida ou resposta 4xx que não vai mudar sozinha. */
export class PermanentWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentWebhookError';
  }
}

export function signBody(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export interface ReplyWebhookJob {
  recipientId: string;
  replyText: string | null;
  repliedAt: string;
}

/**
 * Entrega assíncrona do webhook de resposta do contato. Roda na fila `campaigns` (retry com backoff).
 * Segurança: URL validada contra SSRF a CADA entrega (o DNS pode mudar depois de salvar) e corpo assinado
 * com HMAC-SHA256 (`timestamp.corpo`) para o receptor autenticar a origem e rejeitar replay.
 */
@Injectable()
export class ReplyWebhookService {
  private readonly logger = new Logger(ReplyWebhookService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Monta o payload (sem segredo) — exposto para testes e para a UI de diagnóstico. */
  buildPayload(r: {
    id: string;
    companyName: string;
    customData: unknown;
    renderedText: string | null;
    sentAt: Date | null;
    conversationId: string | null;
    campaign: { id: string; name: string; channel: { id: string; name: string } };
  }, job: ReplyWebhookJob) {
    return {
      event: REPLY_WEBHOOK_EVENT,
      campaign: { id: r.campaign.id, name: r.campaign.name },
      channel: { id: r.campaign.channel.id, name: r.campaign.channel.name },
      lead: {
        recipientId: r.id,
        companyName: r.companyName,
        customData: (r.customData ?? {}) as Record<string, string>,
      },
      sentMessageText: r.renderedText,
      sentAt: r.sentAt?.toISOString() ?? null,
      replyText: job.replyText,
      repliedAt: job.repliedAt,
      conversationId: r.conversationId,
    };
  }

  async deliver(job: ReplyWebhookJob): Promise<{ status: number }> {
    const recipient = await this.prisma.campaignRecipient.findUnique({
      where: { id: job.recipientId },
      include: { campaign: { include: { channel: { select: { id: true, name: true } } } } },
    });
    if (!recipient) throw new PermanentWebhookError('Destinatário não encontrado');
    const { campaign } = recipient;
    if (!campaign.onReplyWebhookUrl || !campaign.onReplyWebhookSecret) {
      throw new PermanentWebhookError('Webhook não configurado nesta campanha');
    }
    // Já entregue (retry após sucesso parcial): idempotente.
    if (recipient.replyWebhookStatus === 'SENT') return { status: 200 };

    const body = JSON.stringify(this.buildPayload(recipient, job));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const attempts = recipient.replyWebhookAttempts + 1;
    await this.prisma.campaignRecipient.update({
      where: { id: recipient.id },
      data: { replyWebhookStatus: 'PENDING', replyWebhookAttempts: attempts },
    });

    try {
      const res = await safePost(campaign.onReplyWebhookUrl, body, {
        headers: {
          'x-intelli-event': REPLY_WEBHOOK_EVENT,
          'x-intelli-timestamp': timestamp,
          'x-intelli-signature': signBody(campaign.onReplyWebhookSecret, timestamp, body),
          'idempotency-key': recipient.id,
        },
      });
      if (res.status >= 200 && res.status < 300) {
        await this.prisma.campaignRecipient.update({
          where: { id: recipient.id },
          data: { replyWebhookStatus: 'SENT', replyWebhookAt: new Date(), replyWebhookError: null },
        });
        return { status: res.status };
      }
      const msg = `HTTP ${res.status}`;
      await this.recordError(recipient.id, msg);
      // 4xx (exceto 408/429) não muda sozinho: não adianta insistir.
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        throw new PermanentWebhookError(msg);
      }
      throw new Error(msg);
    } catch (err: any) {
      if (err instanceof PermanentWebhookError) throw err;
      if (err instanceof UnsafeUrlError) {
        await this.recordError(recipient.id, `URL bloqueada: ${err.message}`);
        throw new PermanentWebhookError(err.message);
      }
      await this.recordError(recipient.id, err.message);
      throw err;
    }
  }

  /** Evento de teste assinado (`campaign.test`) para a URL configurada. Não toca em nenhum destinatário. */
  async sendTest(campaign: { id: string; name: string; onReplyWebhookUrl: string | null; onReplyWebhookSecret: string | null }) {
    const body = JSON.stringify({
      event: 'campaign.test',
      campaign: { id: campaign.id, name: campaign.name },
      lead: { recipientId: 'test', companyName: 'Empresa de teste', customData: { cidade: 'Goiânia' } },
      sentMessageText: 'Mensagem de exemplo da campanha',
      replyText: 'Resposta de exemplo do contato',
      repliedAt: new Date().toISOString(),
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    try {
      const res = await safePost(campaign.onReplyWebhookUrl!, body, {
        headers: {
          'x-intelli-event': 'campaign.test',
          'x-intelli-timestamp': timestamp,
          'x-intelli-signature': signBody(campaign.onReplyWebhookSecret!, timestamp, body),
        },
      });
      return { ok: res.status >= 200 && res.status < 300, status: res.status };
    } catch (err: any) {
      return { ok: false, status: 0, error: err instanceof UnsafeUrlError ? `URL bloqueada: ${err.message}` : err.message };
    }
  }

  /** Esgotou as tentativas (ou falha definitiva): marca FAILED. */
  async markFailed(recipientId: string, message: string): Promise<void> {
    await this.prisma.campaignRecipient
      .update({
        where: { id: recipientId },
        data: { replyWebhookStatus: 'FAILED', replyWebhookError: message.slice(0, 300) },
      })
      .catch((e) => this.logger.warn(`markFailed ${recipientId}: ${e.message}`));
  }

  private async recordError(recipientId: string, message: string): Promise<void> {
    await this.prisma.campaignRecipient
      .update({ where: { id: recipientId }, data: { replyWebhookError: message.slice(0, 300) } })
      .catch(() => undefined);
  }
}
