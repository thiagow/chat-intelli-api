import { Channel, ChannelType } from '@prisma/client';
import {
  BulkControlAction,
  BulkFolder,
  BulkNumberCheck,
  CreateBulkFolderInput,
  ListFolderMessagesResult,
} from './types/bulk-sender.types';

/**
 * Capacidade opcional de um canal: disparar mensagens em massa usando a fila
 * nativa do provider. "Habilitado só para UaZAPI" é uma propriedade do
 * `ChannelAdapterRegistry`, não um `if` espalhado.
 */
export interface BulkSenderPort {
  readonly channelType: ChannelType;

  /** Resolve JID real e presença no WhatsApp. O chamador faz o batching. */
  checkNumbers(channel: Channel, numbers: string[]): Promise<BulkNumberCheck[]>;

  createFolder(channel: Channel, input: CreateBulkFolderInput): Promise<BulkFolder>;

  controlFolder(
    channel: Channel,
    folderId: string,
    action: BulkControlAction,
    options?: { scheduledFor?: number },
  ): Promise<void>;

  listFolders(channel: Channel): Promise<BulkFolder[]>;

  listFolderMessages(
    channel: Channel,
    folderId: string,
    options?: { status?: 'sent' | 'failed' | 'scheduled'; limit?: number; offset?: number },
  ): Promise<ListFolderMessagesResult>;

  /** `false` somente quando o provider confirma que a instância caiu. */
  isConnected(channel: Channel): Promise<boolean>;

  /** Garante que o webhook do canal recebe os eventos de envio em massa. */
  ensureWebhook(channel: Channel, webhookUrl: string): Promise<void>;
}

export const BULK_SENDER_PORT = 'BULK_SENDER_PORT';
