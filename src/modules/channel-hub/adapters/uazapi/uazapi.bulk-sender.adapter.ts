import { Injectable } from '@nestjs/common';
import { Channel, ChannelType } from '@prisma/client';
import { BulkSenderPort } from '../../ports/bulk-sender.port';
import {
  BulkControlAction,
  BulkFolder,
  BulkFolderEvent,
  BulkFolderMessage,
  BulkMessageStatus,
  BulkNumberCheck,
  CreateBulkFolderInput,
  ListFolderMessagesResult,
} from '../../ports/types';
import { UazapiHttpClient } from './uazapi.http-client';

export const UAZAPI_WEBHOOK_EVENTS = ['messages', 'messages_update', 'sender'];

function pickArray(data: any, ...keys: string[]): any[] {
  if (Array.isArray(data)) return data;
  for (const k of keys) if (Array.isArray(data?.[k])) return data[k];
  return [];
}

/** Normaliza o status de mensagem de pasta da UaZAPI. */
export function mapFolderMessageStatus(raw: unknown): BulkMessageStatus {
  const s = String(raw ?? '').toLowerCase();
  if (['sent', 'success', 'delivered', 'read'].includes(s)) return 'SENT';
  if (['failed', 'error'].includes(s)) return 'FAILED';
  if (['scheduled', 'pending', 'queued', 'sending'].includes(s)) return 'PENDING';
  return 'UNKNOWN';
}

/** Interpreta o payload do webhook `sender` (por pasta). */
export function parseSenderEvent(payload: any): BulkFolderEvent | null {
  const body = payload?.event && typeof payload.event === 'object' ? payload.event : payload;
  const folderId = payload?.folderID ?? payload?.folder_id ?? body?.folderID ?? body?.folder_id;
  if (!folderId) return null;
  const status = String(payload?.status ?? body?.status ?? '').toLowerCase();
  return {
    folderId: String(folderId),
    status: status === 'done' ? 'done' : status === 'sending' ? 'sending' : 'unknown',
    successCount: Number(payload?.successCount ?? body?.successCount) || undefined,
    failedCount: Number(payload?.failedCount ?? body?.failedCount) || undefined,
    raw: payload,
  };
}

function toFolder(f: any): BulkFolder {
  return {
    folderId: String(f?.id ?? f?.folder_id ?? f?.folderId ?? ''),
    info: f?.info ?? undefined,
    status: f?.status ?? undefined,
    count: f?.log_total ?? f?.count ?? undefined,
    sent: f?.log_sucess ?? f?.log_success ?? undefined,
    failed: f?.log_failed ?? undefined,
    delivered: f?.log_delivered ?? undefined,
    read: f?.log_read ?? undefined,
  };
}

@Injectable()
export class UazapiBulkSenderAdapter implements BulkSenderPort {
  readonly channelType = ChannelType.WHATSAPP_UAZAPI;

  constructor(private readonly http: UazapiHttpClient) {}

  async checkNumbers(channel: Channel, numbers: string[]): Promise<BulkNumberCheck[]> {
    const data = await this.http.checkNumbers(channel, numbers);
    return pickArray(data, 'results', 'data', 'numbers').map((r: any) => ({
      query: String(r?.query ?? ''),
      jid: r?.jid ? String(r.jid) : null,
      isInWhatsapp: !!r?.isInWhatsapp,
    }));
  }

  async createFolder(channel: Channel, input: CreateBulkFolderInput): Promise<BulkFolder> {
    const data = await this.http.senderAdvanced(channel, {
      messages: input.messages.map((m) => ({ number: m.number, type: 'text', text: m.text })),
      delayMin: input.delayMinSec,
      delayMax: input.delayMaxSec,
      info: input.info,
      ...(input.scheduledFor && { scheduled_for: input.scheduledFor }),
    });
    const folderId = data?.folder_id ?? data?.folderId ?? data?.id;
    if (!folderId) {
      throw new Error(`UaZAPI /sender/advanced sem folder_id: ${JSON.stringify(data)}`);
    }
    return { folderId: String(folderId), info: input.info, status: data?.status, count: data?.count };
  }

  async controlFolder(
    channel: Channel,
    folderId: string,
    action: BulkControlAction,
    options: { scheduledFor?: number } = {},
  ): Promise<void> {
    await this.http.senderEdit(channel, {
      folder_id: folderId,
      action,
      ...(options.scheduledFor && { scheduled_for: options.scheduledFor }),
    });
  }

  async listFolders(channel: Channel): Promise<BulkFolder[]> {
    const data = await this.http.senderListFolders(channel);
    return pickArray(data, 'folders', 'data').map(toFolder).filter((f) => f.folderId);
  }

  async listFolderMessages(
    channel: Channel,
    folderId: string,
    options: { status?: 'sent' | 'failed' | 'scheduled'; limit?: number; offset?: number } = {},
  ): Promise<ListFolderMessagesResult> {
    const limit = Math.min(options.limit ?? 1000, 1000);
    const data = await this.http.senderListMessages(channel, {
      folder_id: folderId,
      limit,
      offset: options.offset ?? 0,
      ...(options.status && { messageStatus: options.status }),
    });
    const rows = pickArray(data, 'messages', 'data');
    const messages: BulkFolderMessage[] = rows.map((r: any) => ({
      chatId: String(r?.chatid ?? r?.chatId ?? r?.number ?? ''),
      providerMessageId: r?.messageid ?? r?.messageId ?? undefined,
      status: mapFolderMessageStatus(r?.status),
      error: r?.error ? String(r.error) : undefined,
    }));
    return { messages, hasMore: rows.length >= limit };
  }

  async isConnected(channel: Channel): Promise<boolean> {
    const status = await this.http.getInstanceStatus(channel);
    const rawState = status?.state;
    const s =
      typeof rawState === 'string'
        ? rawState
        : typeof rawState === 'object' && rawState?.status
          ? String(rawState.status)
          : typeof status?.status === 'string'
            ? status.status
            : null;
    if (!s) return true; // indeterminado: não pausa por palpite
    return ['connected', 'open'].includes(s.toLowerCase());
  }

  async ensureWebhook(channel: Channel, webhookUrl: string): Promise<void> {
    await this.http.configureWebhook(channel, webhookUrl, UAZAPI_WEBHOOK_EVENTS);
  }
}
