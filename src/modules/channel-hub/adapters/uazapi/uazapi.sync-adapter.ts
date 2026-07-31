import { Injectable, Logger } from '@nestjs/common';
import { Channel, ChannelType, MessageDirection } from '@prisma/client';
import { HistorySyncPort } from '../../ports/history-sync.port';
import {
  FetchConversationsResult,
  FetchMessagesResult,
  HistorySyncFilters,
  NormalizedHistoricalConversation,
  NormalizedHistoricalMessage,
  SyncCapabilities,
} from '../../ports/types';
import { UazapiHttpClient } from './uazapi.http-client';
import { UazapiMessageMapper } from './uazapi.message-mapper';

/**
 * History-sync implementation for Uazapi. Mirrors the webhook mapper so
 * messages imported by sync look identical to messages received live.
 *
 * IMPORTANT: per Uazapi's public docs, the server only retains ~7 days of
 * message history (nightly purge) — `maxLookbackDays` is capped accordingly
 * instead of the 365 days Zappfy claims. Confirm this limit with Uazapi
 * support before relying on it for older imports.
 */
@Injectable()
export class UazapiSyncAdapter implements HistorySyncPort {
  readonly channelType = ChannelType.WHATSAPP_UAZAPI;
  private readonly logger = new Logger(UazapiSyncAdapter.name);

  constructor(
    private readonly httpClient: UazapiHttpClient,
    private readonly mapper: UazapiMessageMapper,
  ) {}

  getSyncCapabilities(): SyncCapabilities {
    return {
      supportsHistoryImport: true,
      supportsDeltaSync: true,
      defaultLookbackDays: 7,
      maxLookbackDays: 7,
    };
  }

  async fetchConversations(
    channel: Channel,
    filters: HistorySyncFilters,
    cursor?: string,
    limit = 50,
  ): Promise<FetchConversationsResult> {
    const offset = cursor ? parseInt(cursor, 10) || 0 : 0;
    // Grupo desabilitado de propósito — não faz sentido pro negócio agora.
    // Pede pro provider já filtrar (isGroup: false), sem custo extra.
    const response = await this.httpClient.fetchChats(channel, { limit, offset, isGroup: false });
    const rawChats: any[] = response?.chats || [];

    const conversations: NormalizedHistoricalConversation[] = [];
    for (const chat of rawChats) {
      const externalId = chat.wa_chatid || chat.chatid || chat.id;
      if (!externalId) continue;
      // Defesa extra caso o filtro do provider não seja 100% confiável.
      if (String(externalId).endsWith('@g.us')) continue;

      const name =
        chat.wa_contactName || chat.wa_name || chat.name || chat.phone || externalId;
      const phone = chat.phone || String(externalId).replace(/@.*/, '');
      const lastMessageAt = this.parseTs(chat.wa_lastMsgTimestamp);

      if (filters.sinceTimestamp && lastMessageAt && lastMessageAt < filters.sinceTimestamp) {
        continue;
      }

      conversations.push({
        externalConversationId: String(externalId),
        externalContactId: String(externalId),
        contactName: name,
        contactPhone: phone,
        contactAvatarUrl: chat.wa_profilePicUrl || undefined,
        isGroup: false,
        lastMessageAt,
        unreadCount: Number(chat.wa_unreadCount ?? 0),
        rawPayload: chat,
      });
    }

    const hasNext = response?.pagination?.hasNextPage ?? rawChats.length >= limit;
    return {
      conversations,
      nextCursor: hasNext ? String(offset + rawChats.length) : undefined,
    };
  }

  async fetchMessages(
    channel: Channel,
    externalConversationId: string,
    filters: HistorySyncFilters,
    cursor?: string,
    limit = 50,
  ): Promise<FetchMessagesResult> {
    const offset = cursor ? parseInt(cursor, 10) || 0 : 0;
    const response = await this.httpClient.fetchMessages(
      channel,
      externalConversationId,
      limit,
      offset,
    );
    const rawMessages: any[] = response?.messages || [];

    const messages: NormalizedHistoricalMessage[] = [];
    let reachedLookbackLimit = false;

    for (const raw of rawMessages) {
      const event = { message: raw, chat: { chatid: externalConversationId } };
      const normalized = this.mapper.normalizeInbound(event as any);
      if (!normalized) continue;

      if (filters.sinceTimestamp && normalized.timestamp < filters.sinceTimestamp) {
        reachedLookbackLimit = true;
        break;
      }

      const direction = raw.fromMe
        ? MessageDirection.OUTBOUND
        : MessageDirection.INBOUND;

      messages.push({
        externalMessageId: normalized.externalMessageId,
        externalConversationId,
        externalContactId: externalConversationId,
        direction,
        timestamp: normalized.timestamp,
        type: normalized.type,
        content: normalized.content,
        senderName: normalized.senderName,
        replyToExternalId: normalized.replyTo?.externalMessageId,
        rawPayload: raw,
      });
    }

    const hasNext =
      !reachedLookbackLimit &&
      (response?.pagination?.hasNextPage ?? rawMessages.length >= limit);
    return {
      messages,
      nextCursor: hasNext ? String(offset + rawMessages.length) : undefined,
    };
  }

  private parseTs(ts: any): Date | undefined {
    if (!ts) return undefined;
    const num = typeof ts === 'string' ? parseInt(ts, 10) : Number(ts);
    if (!num || isNaN(num)) return undefined;
    return new Date(num > 9999999999 ? num : num * 1000);
  }
}
