/**
 * Tipos do envio em massa nativo do provider (hoje só UaZAPI `/sender/*`).
 * Não há fila de envio própria: o provider executa a pasta com o intervalo
 * randômico configurado e nós só acompanhamos/reconciliamos.
 */

export interface BulkNumberCheck {
  /** Número consultado, como enviado. */
  query: string;
  /** JID real resolvido pelo WhatsApp (resolve o 9º dígito). */
  jid: string | null;
  isInWhatsapp: boolean;
}

export interface BulkMessageInput {
  /** Telefone E.164 só com dígitos, ou JID. */
  number: string;
  text: string;
  /** Digitação simulada (ms) antes do envio desta mensagem ("Digitando…"). Sorteada por mensagem. */
  typingMs?: number;
}

export interface CreateBulkFolderInput {
  messages: BulkMessageInput[];
  delayMinSec: number;
  delayMaxSec: number;
  /** Identificador idempotente (`ic:<campaignId>:<batchIndex>`). */
  info: string;
  /** Epoch ms do início do envio. Omitido = começa agora. */
  scheduledFor?: number;
}

export interface BulkFolder {
  folderId: string;
  info?: string;
  status?: string;
  count?: number;
  /** Contadores informados pelo provider (pasta). */
  sent?: number;
  failed?: number;
  delivered?: number;
  read?: number;
}

export type BulkControlAction =
  | 'stop'
  | 'continue'
  | 'delete'
  | 'send_now'
  | 'reschedule';

export type BulkMessageStatus = 'PENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'UNKNOWN';

export interface BulkFolderMessage {
  /** JID do destinatário (`chatid`). */
  chatId: string;
  providerMessageId?: string;
  status: BulkMessageStatus;
  error?: string;
}

export interface ListFolderMessagesResult {
  messages: BulkFolderMessage[];
  hasMore: boolean;
}

/** Evento `sender` do webhook (por pasta). */
export interface BulkFolderEvent {
  folderId: string;
  status: 'sending' | 'done' | 'unknown';
  successCount?: number;
  failedCount?: number;
  raw?: unknown;
}
