import { Injectable, Logger } from '@nestjs/common';
import {
  CampaignRecipient,
  CampaignRecipientStatus,
  CampaignReplyRouting,
  MessageContentType,
  MessageDirection,
  MessageStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { isOptOutText, sameRenderedText } from '../campaign-text';

const RANK: Partial<Record<CampaignRecipientStatus, number>> = {
  QUEUED: 0,
  SENT: 1,
  DELIVERED: 2,
  READ: 3,
};

const SENT_LIKE: CampaignRecipientStatus[] = ['SENT', 'DELIVERED', 'READ'];

export interface CampaignEchoInput {
  organizationId: string;
  channelId: string;
  contactId: string;
  externalMessageId: string;
  text: string | null;
  timestamp?: Date | string;
}

export interface CampaignInboundInput {
  organizationId: string;
  channelId: string;
  contactId: string;
  conversationId: string;
  /** Conversa criada ou reaberta por ESTA mensagem: o roteamento só vale aí. */
  conversationIsFresh: boolean;
  text: string | null;
}

/**
 * Rastreio de campanhas dentro do pipeline de inbound. Depende só do Prisma
 * (e do gateway de realtime) para poder ser importado pelo MessagingModule
 * sem ciclo: o módulo de campanhas não importa o messaging.
 */
@Injectable()
export class CampaignTrackingService {
  private readonly logger = new Logger(CampaignTrackingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /**
   * Echo (`fromMe`) de mensagem de campanha. Devolve `true` quando o echo foi
   * consumido (o pipeline NÃO deve criar conversa). Três travas para nunca
   * engolir mensagem real do atendente / enviada pelo celular:
   *  1. já existe `Message` com esse externalId no canal → foi enviada pela plataforma;
   *  2. existe recipient do mesmo (canal, contato) em lote ativo;
   *  3. o texto normalizado bate com o `renderedText` desse recipient.
   */
  async tryConsumeEcho(input: CampaignEchoInput): Promise<boolean> {
    if (!input.text) return false;

    const existing = await this.prisma.message.findFirst({
      where: {
        externalId: input.externalMessageId,
        conversation: { channelId: input.channelId },
      },
      select: { id: true },
    });
    if (existing) return false;

    const candidates = await this.prisma.campaignRecipient.findMany({
      where: {
        organizationId: input.organizationId,
        contactId: input.contactId,
        status: { in: ['QUEUED', ...SENT_LIKE] },
        repliedAt: null,
        renderedText: { not: null },
        campaign: { channelId: input.channelId, deletedAt: null },
        batch: { status: { in: ['SUBMITTING', 'SCHEDULED', 'RUNNING', 'DONE'] } },
        OR: [{ providerMessageId: null }, { providerMessageId: input.externalMessageId }],
      },
      orderBy: { updatedAt: 'desc' },
      take: 5,
    });

    const match = candidates.find((r) => r.renderedText && sameRenderedText(r.renderedText, input.text!));
    if (!match) return false;

    const at = input.timestamp ? new Date(input.timestamp) : new Date();
    const patch: Prisma.CampaignRecipientUpdateInput = {};
    if (!match.providerMessageId) patch.providerMessageId = input.externalMessageId;
    if (match.status === 'QUEUED') patch.status = 'SENT';
    if (!match.sentAt) patch.sentAt = at;
    if (Object.keys(patch).length) {
      await this.prisma.campaignRecipient.update({ where: { id: match.id }, data: patch });
    }
    return true;
  }

  /**
   * Resposta do destinatário (inbound). Insere a mensagem da campanha no
   * histórico da conversa, aplica o roteamento escolhido, marca REPLIED e
   * trata opt-out. Chamado depois do resolve da conversa.
   */
  async onInbound(input: CampaignInboundInput): Promise<void> {
    try {
      await this.handleReply(input);
      await this.handleOptOut(input);
    } catch (err: any) {
      // Rastreio nunca pode derrubar o pipeline de inbound.
      this.logger.error(`Campaign inbound hook falhou: ${err.message}`, err.stack);
    }
  }

  private async handleReply(input: CampaignInboundInput): Promise<void> {
    const recipients = await this.prisma.campaignRecipient.findMany({
      where: {
        organizationId: input.organizationId,
        contactId: input.contactId,
        status: { in: SENT_LIKE },
        repliedAt: null,
        campaign: { channelId: input.channelId, deletedAt: null },
      },
      include: { campaign: { select: { id: true, replyRouting: true, replyWindowDays: true } } },
      orderBy: { sentAt: 'desc' },
      take: 5,
    });
    const now = Date.now();
    const recipient = recipients.find(
      (r) => r.sentAt && now - r.sentAt.getTime() <= r.campaign.replyWindowDays * 86_400_000,
    );
    if (!recipient) return;

    const messageId = await this.materializeCampaignMessage(recipient, input.conversationId);

    if (input.conversationIsFresh) {
      await this.applyRouting(input.conversationId, recipient.campaign.replyRouting);
    }

    await this.prisma.campaignRecipient.update({
      where: { id: recipient.id },
      data: {
        repliedAt: new Date(),
        conversationId: input.conversationId,
        ...(messageId && { messageId }),
      },
    });
    this.realtime.emitToOrg(input.organizationId, 'campaign:reply', {
      campaignId: recipient.campaignId,
      recipientId: recipient.id,
      conversationId: input.conversationId,
    });
  }

  private async materializeCampaignMessage(
    recipient: CampaignRecipient,
    conversationId: string,
  ): Promise<string | null> {
    if (recipient.messageId || !recipient.renderedText) return recipient.messageId;

    const statusMap: Record<string, MessageStatus> = {
      SENT: MessageStatus.SENT,
      DELIVERED: MessageStatus.DELIVERED,
      READ: MessageStatus.READ,
    };
    try {
      const msg = await this.prisma.message.create({
        data: {
          conversationId,
          direction: MessageDirection.OUTBOUND,
          type: MessageContentType.TEXT,
          content: { text: recipient.renderedText },
          externalId: recipient.providerMessageId ?? null,
          status: statusMap[recipient.status] ?? MessageStatus.SENT,
          senderName: 'Campanha',
          sentAt: recipient.sentAt,
          deliveredAt: recipient.deliveredAt,
          readAt: recipient.readAt,
          providerTimestamp: recipient.sentAt,
          createdAt: recipient.sentAt ?? undefined,
          metadata: { source: 'campaign', campaignId: recipient.campaignId },
        },
        select: { id: true },
      });
      return msg.id;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.prisma.message.findFirst({
          where: { conversationId, externalId: recipient.providerMessageId },
          select: { id: true },
        });
        return existing?.id ?? null;
      }
      throw err;
    }
  }

  private async applyRouting(conversationId: string, routing: CampaignReplyRouting): Promise<void> {
    if (routing === 'CHANNEL_DEFAULT') return;
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { aiEnabled: routing === 'AI' },
    });
  }

  private async handleOptOut(input: CampaignInboundInput): Promise<void> {
    if (!isOptOutText(input.text)) return;

    const received = await this.prisma.campaignRecipient.findFirst({
      where: {
        organizationId: input.organizationId,
        contactId: input.contactId,
        status: { in: SENT_LIKE },
      },
      orderBy: { sentAt: 'desc' },
      select: { campaignId: true },
    });
    if (!received) return;

    const updated = await this.prisma.contact.updateMany({
      where: { id: input.contactId, organizationId: input.organizationId, marketingOptOutAt: null },
      data: { marketingOptOutAt: new Date(), marketingOptOutSource: `campaign:${received.campaignId}` },
    });
    if (updated.count > 0) {
      this.realtime.emitToOrg(input.organizationId, 'contact:opted-out', {
        contactId: input.contactId,
        campaignId: received.campaignId,
      });
    }
  }

  /**
   * Status (entregue/lido) sem `Message` correspondente: aplica no recipient por
   * `providerMessageId`, escopado ao canal, sem nunca regredir o estado.
   */
  async applyStatus(params: {
    channelId: string;
    organizationId?: string;
    providerMessageId: string;
    status: MessageStatus;
    timestamp?: Date | string;
  }): Promise<boolean> {
    const target: CampaignRecipientStatus | null =
      params.status === 'SENT'
        ? 'SENT'
        : params.status === 'DELIVERED'
          ? 'DELIVERED'
          : params.status === 'READ'
            ? 'READ'
            : params.status === 'FAILED'
              ? 'FAILED'
              : null;
    if (!target) return false;

    const recipient = await this.prisma.campaignRecipient.findFirst({
      where: {
        providerMessageId: params.providerMessageId,
        campaign: { channelId: params.channelId },
        ...(params.organizationId && { organizationId: params.organizationId }),
      },
    });
    if (!recipient) return false;

    const at = params.timestamp ? new Date(params.timestamp) : new Date();
    const data: Prisma.CampaignRecipientUpdateInput = {};
    if (target === 'FAILED') {
      if (RANK[recipient.status] === undefined || recipient.status === 'QUEUED') data.status = 'FAILED';
    } else if ((RANK[target] ?? 0) > (RANK[recipient.status] ?? -1)) {
      data.status = target;
    }
    if (target === 'SENT' && !recipient.sentAt) data.sentAt = at;
    if (target === 'DELIVERED') {
      if (!recipient.deliveredAt) data.deliveredAt = at;
      if (!recipient.sentAt) data.sentAt = at;
    }
    if (target === 'READ') {
      if (!recipient.readAt) data.readAt = at;
      if (!recipient.deliveredAt) data.deliveredAt = at;
      if (!recipient.sentAt) data.sentAt = at;
    }
    if (Object.keys(data).length) {
      await this.prisma.campaignRecipient.update({ where: { id: recipient.id }, data });
    }
    return true;
  }
}
