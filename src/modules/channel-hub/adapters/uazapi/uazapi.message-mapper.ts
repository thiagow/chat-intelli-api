import { Injectable } from '@nestjs/common';
import { ChannelType } from '@prisma/client';
import {
  NormalizedInboundMessage,
  NormalizedOutboundMessage,
  MessageContentType,
  StatusUpdate,
  TemplateButton,
} from '../../ports/types';

/**
 * NOTE on validation status (2026-07-31):
 *  - `denormalize()` (outbound/send side) is confirmed against Uazapi's
 *    official endpoint reference (/send/text, /send/media, /send/location,
 *    /message/react) — field names (`number`, `file`, `type`, `docName`,
 *    `text` as the caption field, `replyid`, `mentions`, `readchat`,
 *    `readmessages`) all match the documented request bodies exactly.
 *  - `normalizeInbound()` for a plain 1:1 TEXT message (`messageType:
 *    "ExtendedTextMessage"`, `EventType: "messages"`) is confirmed against a
 *    real webhook payload from a trial account. That capture also confirmed:
 *    the outer envelope has `EventType` (not `event`), `token` (the instance
 *    token — used directly by `matchesChannel`'s token-match path), `owner`
 *    (the connected number, used as instanceId fallback), and `chat.*` uses
 *    `wa_contactName`/`wa_name` for the display name (`chat.name` is always
 *    empty — this cost a real bug, since fixed).
 *  - STILL UNVALIDATED: media messages (image/video/audio/document/sticker),
 *    group messages, replies/quotes, reactions, and `normalizeStatus()`
 *    (the `messages_update` event shape). These branches mirror the Zappfy
 *    mapper on the assumption both run the same engine, but that's an
 *    inference for these specific shapes, not confirmed. Validate each
 *    before relying on it in production — the Zappfy integration's history
 *    shows several silent field-name bugs (e.g. `stanzaID` vs `stanzaId`)
 *    that only surfaced against real traffic.
 */
@Injectable()
export class UazapiMessageMapper {
  normalizeInbound(event: any): NormalizedInboundMessage | null {
    const msg = event?.message;
    if (!msg) return null;

    const chatid = msg.chatid || '';
    const isGroup = chatid.endsWith('@g.us');
    // Grupo desabilitado de propósito — não faz sentido pro negócio agora.
    // Ignora silenciosamente qualquer mensagem de grupo: nenhuma conversa é
    // criada, nenhum contato de grupo aparece no inbox.
    if (isGroup) return null;

    const phone = chatid.replace(/@s\.whatsapp\.net|@g\.us/g, '');
    const isEcho = msg.fromMe === true;

    // contactName resolution (grupo já foi descartado acima, então isEcho é
    // a única bifurcação que resta):
    //  - 1-on-1 inbound: senderName = quem mandou = correto.
    //  - 1-on-1 echo (fromMe=true): senderName somos NÓS (o WhatsApp
    //    conectado), não o contato — cai pro nome do chat.
    //
    // CONFIRMED against a real webhook payload (2026-07-31): `chat.name` is
    // ALWAYS empty string in practice — the real name lives in
    // `chat.wa_contactName`/`chat.wa_name` (same fields already used in
    // uazapi.sync-adapter.ts / uazapi-contact-enricher.service.ts for the
    // same `chat` object shape).
    const chatDisplayName =
      event?.chat?.wa_contactName || event?.chat?.wa_name || event?.chat?.name;
    const resolvedContactName = isEcho
      ? chatDisplayName
      : msg.senderName || chatDisplayName;

    const result: NormalizedInboundMessage = {
      externalMessageId: msg.messageid || msg.id || '',
      externalContactId: chatid,
      contactName: resolvedContactName,
      contactPhone: phone,
      channelType: ChannelType.WHATSAPP_UAZAPI,
      timestamp: new Date(msg.messageTimestamp || Date.now()),
      type: this.resolveContentType(msg),
      content: this.extractContent(msg),
      isForwarded: typeof msg.content === 'object' && !!msg.content?.contextInfo?.isForwarded,
      isGroup: false,
      isEcho,
      senderName: isEcho ? (msg.senderName?.trim() || msg.pushName?.trim() || undefined) : undefined,
      rawPayload: event,
    };

    const replyTo = this.extractReply(msg);
    if (replyTo) result.replyTo = replyTo;

    return result;
  }

  /**
   * Reply nativo (usuário citou uma mensagem no app do WhatsApp). O id da
   * citada pode vir em `msg.quoted` ou `contextInfo.stanzaID` — mantém a
   * checagem de ambas as grafias (D maiúsculo incluso) como precaução, já
   * que a Zappfy (mesmo motor) precisou disso na prática.
   */
  private extractReply(msg: any): { externalMessageId: string; previewText?: string } | null {
    const ctx = typeof msg?.content === 'object' ? msg.content?.contextInfo : null;
    const externalMessageId =
      (typeof msg?.quoted === 'string' && msg.quoted.trim()) ||
      ctx?.stanzaID ||
      ctx?.stanzaId ||
      null;
    if (!externalMessageId) return null;

    const previewText = this.previewFromQuoted(ctx?.quotedMessage);
    return previewText ? { externalMessageId, previewText } : { externalMessageId };
  }

  private previewFromQuoted(quoted: any): string | undefined {
    if (!quoted || typeof quoted !== 'object') return undefined;

    const text =
      quoted.conversation ||
      quoted.extendedTextMessage?.text ||
      quoted.imageMessage?.caption ||
      quoted.videoMessage?.caption ||
      quoted.documentMessage?.caption;
    if (typeof text === 'string' && text.trim()) return text.trim();

    if (quoted.imageMessage) return '[imagem]';
    if (quoted.videoMessage || quoted.ptvMessage) return '[vídeo]';
    if (quoted.audioMessage) return '[áudio]';
    if (quoted.stickerMessage) return '[figurinha]';
    if (quoted.documentMessage) {
      const name = quoted.documentMessage.fileName;
      return typeof name === 'string' && name.trim() ? name.trim() : '[documento]';
    }
    if (quoted.locationMessage) return '[localização]';
    if (quoted.contactMessage) {
      const name = quoted.contactMessage.displayName;
      return typeof name === 'string' && name.trim() ? `Contato: ${name.trim()}` : '[contato]';
    }
    if (quoted.pollCreationMessage || quoted.pollCreationMessageV3) {
      const name = quoted.pollCreationMessage?.name || quoted.pollCreationMessageV3?.name;
      return typeof name === 'string' && name.trim() ? `Enquete: ${name.trim()}` : '[enquete]';
    }
    return undefined;
  }

  /**
   * Uazapi manda status update em pelo menos duas formas documentadas:
   *  A) CONFIRMADO em payload real (2026-07-31): evento `messages_update` com
   *     `{ EventType: 'messages_update', event: { MessageIDs: [...],
   *     Type: 'Read', Timestamp }, state: 'Read' }` — formato que existia na
   *     ZappFy original e foi perdido sem querer ao portar pra Uazapi; sem
   *     ele, TODO status update (entregue/lido) era ignorado silenciosamente.
   *  B) `{ message: { messageid, status, ack, timestamp } }`
   *  C) baileys-style numeric ack em lote: `{ messages: [{ id, ack }] }`
   * Aceita as três e converte pro StatusUpdate comum.
   */
  normalizeStatus(event: any): StatusUpdate | null {
    if (!event) return null;

    const tsToDate = (ts: any): Date => {
      const num = typeof ts === 'string' ? parseInt(ts, 10) : Number(ts);
      if (!num || isNaN(num)) return new Date();
      return new Date(num > 9999999999 ? num : num * 1000);
    };

    const numericAckMap: Record<number, StatusUpdate['status']> = {
      1: 'sent',
      2: 'delivered',
      3: 'read',
      4: 'read',
      5: 'failed',
    };

    const stringStatusMap: Record<string, StatusUpdate['status']> = {
      sent: 'sent',
      delivered: 'delivered',
      read: 'read',
      played: 'read',
      deleted: 'failed',
      failed: 'failed',
      error: 'failed',
      pending: 'sent',
    };

    // Shape A — confirmado real: { event: { MessageIDs: [...], Type, Timestamp }, state }
    const statusEvent = event?.event;
    if (statusEvent && Array.isArray(statusEvent.MessageIDs) && statusEvent.MessageIDs.length > 0) {
      const stateStr = String(event?.state || statusEvent?.Type || '').toLowerCase();
      const status = stringStatusMap[stateStr];
      if (status) {
        return {
          externalMessageId: String(statusEvent.MessageIDs[0]),
          status,
          timestamp: tsToDate(statusEvent?.Timestamp),
        };
      }
    }

    // Shape B
    const bMsg = event?.message;
    if (bMsg && (bMsg.messageid || bMsg.id)) {
      const stateStr = String(bMsg.status || event?.state || '').toLowerCase();
      const numeric = typeof bMsg.ack === 'number' ? bMsg.ack : undefined;
      const status =
        numeric !== undefined ? numericAckMap[numeric] : stringStatusMap[stateStr];
      if (status) {
        return {
          externalMessageId: String(bMsg.messageid || bMsg.id),
          status,
          timestamp: tsToDate(bMsg.timestamp || bMsg.messageTimestamp),
        };
      }
    }

    // Shape C
    if (Array.isArray(event?.messages)) {
      const first = event.messages.find((m: any) => m?.id && (m.ack != null || m.status));
      if (first) {
        const numeric = typeof first.ack === 'number' ? first.ack : undefined;
        const status =
          numeric !== undefined
            ? numericAckMap[numeric]
            : stringStatusMap[String(first.status || '').toLowerCase()];
        if (status) {
          return {
            externalMessageId: String(first.id),
            status,
            timestamp: tsToDate(first.timestamp),
          };
        }
      }
    }

    return null;
  }

  denormalize(
    message: NormalizedOutboundMessage,
    contactExternalId: string,
  ): { endpoint: string; payload: Record<string, any> } {
    const number = contactExternalId.replace(/@s\.whatsapp\.net|@g\.us/g, '');
    const replyId = message.replyTo?.externalMessageId;
    // Confirmado no /send/text, /send/media e /send/location oficiais:
    // `readchat` marca a conversa como lida e `readmessages` marca as
    // últimas mensagens recebidas como lidas, ambos no momento do envio.
    // Cobre o gap do markConversationRead (que a Uazapi não implementa como
    // endpoint isolado confirmado) pro caso mais comum: atendente responde
    // → o cliente vê o duplo check azul. Aplicado em TODO envio que passa
    // por um desses 3 endpoints — não em /message/react (REACTION abaixo),
    // que não documenta esses campos.
    const withReply = <T extends Record<string, any>>(p: T): T => ({
      ...p,
      ...(replyId && { replyid: replyId }),
      readchat: true,
      readmessages: true,
    } as T);

    const rawMentions = message.content.mentions;
    const isGroupTarget = contactExternalId.endsWith('@g.us');
    const mentions =
      isGroupTarget && rawMentions
        ? rawMentions === 'all'
          ? 'all'
          : [...new Set(rawMentions.map((m) => String(m).replace(/\D/g, '')))]
              .filter(Boolean)
              .join(',') || undefined
        : undefined;
    const withMentions = <T extends Record<string, any>>(p: T): T =>
      mentions ? ({ ...p, mentions } as T) : p;
    const withExtras = <T extends Record<string, any>>(p: T): T =>
      withMentions(withReply(p));

    switch (message.type) {
      case MessageContentType.TEXT:
        return {
          endpoint: '/send/text',
          payload: withExtras({ number, text: message.content.text, delay: 1000 }),
        };

      case MessageContentType.IMAGE:
        return {
          endpoint: '/send/media',
          payload: withExtras({
            number,
            file: message.content.mediaUrl,
            type: 'image',
            text: message.content.caption || '',
          }),
        };

      case MessageContentType.AUDIO:
        return {
          endpoint: '/send/media',
          payload: withReply({
            number,
            file: message.content.mediaUrl,
            // "ptt" renderiza como nota de voz nativa; "audio" chegaria como
            // arquivo encaminhado — UX errada pra áudio gravado no app.
            type: 'ptt',
          }),
        };

      case MessageContentType.VIDEO:
        return {
          endpoint: '/send/media',
          payload: withExtras({
            number,
            file: message.content.mediaUrl,
            type: 'video',
            text: message.content.caption || '',
          }),
        };

      case MessageContentType.DOCUMENT:
        return {
          endpoint: '/send/media',
          payload: withExtras({
            number,
            file: message.content.mediaUrl,
            type: 'document',
            docName: message.content.fileName || '',
            text: message.content.caption || '',
          }),
        };

      case MessageContentType.STICKER:
        return {
          endpoint: '/send/media',
          payload: withReply({
            number,
            file: message.content.mediaUrl,
            type: 'sticker',
          }),
        };

      case MessageContentType.LOCATION:
        return {
          endpoint: '/send/location',
          payload: withReply({
            number,
            latitude: String(message.content.latitude),
            longitude: String(message.content.longitude),
            name: message.content.text || '',
            address: '',
          }),
        };

      case MessageContentType.REACTION:
        return {
          endpoint: '/message/react',
          payload: {
            chatid: contactExternalId,
            messageid: message.content.reaction?.targetMessageId,
            reaction: message.content.reaction?.emoji,
          },
        };

      default:
        return {
          endpoint: '/send/text',
          payload: withReply({ number, text: message.content.text || '' }),
        };
    }
  }

  private resolveContentType(msg: any): MessageContentType {
    const type = (msg.messageType || '').toLowerCase();
    if (type.includes('text') || type === 'conversation' || type === 'extendedtextmessage')
      return MessageContentType.TEXT;
    if (type.includes('image')) return MessageContentType.IMAGE;
    if (type.includes('audio') || type.includes('ptt')) return MessageContentType.AUDIO;
    if (type.includes('video')) return MessageContentType.VIDEO;
    if (type.includes('document')) return MessageContentType.DOCUMENT;
    if (type.includes('sticker')) return MessageContentType.STICKER;
    if (type.includes('location')) return MessageContentType.LOCATION;
    if (type.includes('reaction')) return MessageContentType.REACTION;
    if (type.includes('ptv')) return MessageContentType.VIDEO;
    if (type.includes('templatebuttonreply')) return MessageContentType.TEXT;
    if (type.includes('template')) return MessageContentType.TEMPLATE;
    if (type.includes('contact')) return MessageContentType.TEXT;
    if (type.includes('poll')) return MessageContentType.TEXT;
    if (type.includes('album')) return MessageContentType.TEXT;
    if (type.includes('groupinvite')) return MessageContentType.TEXT;
    if (type.includes('button') || type.includes('list')) return MessageContentType.INTERACTIVE;
    return MessageContentType.TEXT;
  }

  private extractContent(msg: any): NormalizedInboundMessage['content'] {
    const raw = msg.content;
    const type = (msg.messageType || '').toLowerCase();

    if (typeof raw === 'string') {
      return { text: raw };
    }

    const content = raw || {};

    if (type.includes('text') || type === 'conversation' || type === 'extendedtextmessage') {
      return { text: content.text || content.conversation || '' };
    }
    if (type.includes('image')) {
      return {
        mediaUrl: content.url || content.URL || content.mediaUrl,
        mimeType: content.mimetype,
        fileSize: content.fileLength,
        caption: content.caption,
      };
    }
    if (type.includes('audio') || type.includes('ptt')) {
      return {
        mediaUrl: content.url || content.URL || content.mediaUrl,
        mimeType: content.mimetype,
        fileSize: content.fileLength,
      };
    }
    if (type.includes('video')) {
      return {
        mediaUrl: content.url || content.URL || content.mediaUrl,
        mimeType: content.mimetype,
        fileSize: content.fileLength,
        caption: content.caption,
      };
    }
    if (type.includes('document')) {
      return {
        mediaUrl: content.url || content.URL || content.mediaUrl,
        mimeType: content.mimetype,
        fileName: content.fileName,
        fileSize: content.fileLength,
        caption: content.caption,
      };
    }
    if (type.includes('sticker')) {
      return {
        mediaUrl: content.url || content.URL || content.mediaUrl,
        mimeType: content.mimetype,
      };
    }
    if (type.includes('location')) {
      return {
        latitude: content.degreesLatitude,
        longitude: content.degreesLongitude,
        text: content.name || content.address,
      };
    }
    if (type.includes('reaction')) {
      return {
        reaction: {
          emoji: content.text || msg.text || '',
          targetMessageId: msg.reaction || content.key?.ID || '',
        },
      };
    }
    if (type.includes('ptv')) {
      return {
        mediaUrl: content.URL || content.url || content.mediaUrl,
        mimeType: content.mimetype || 'video/mp4',
        fileSize: content.fileLength,
      };
    }
    if (type.includes('contact')) {
      return { text: this.formatContact(content, msg) };
    }
    if (type.includes('groupinvite')) {
      const groupName = (content.groupName || '').trim();
      return {
        text: groupName
          ? `Convite para o grupo: ${groupName}`
          : content.caption || msg.text || '[convite de grupo]',
      };
    }
    if (type.includes('poll')) {
      return { text: this.formatPoll(content, msg) };
    }
    if (type.includes('album')) {
      return { text: this.formatAlbum(content) };
    }
    if (type.includes('templatebuttonreply')) {
      return { text: msg.text || msg.buttonOrListid || '' };
    }
    if (type.includes('template')) {
      return {
        text: msg.text || '',
        template: {
          templateType: 'hydrated',
          text: msg.text || '',
          buttons: this.extractTemplateButtons(content),
        },
      };
    }
    if (type.includes('button') || type.includes('list')) {
      return this.formatInteractive(content, msg);
    }

    return { text: content.text || msg.text || '[Mensagem não suportada]' };
  }

  private formatInteractive(content: any, msg: any): NormalizedInboundMessage['content'] {
    const chosen =
      content.Response?.SelectedDisplayText ||
      content.selectedDisplayText ||
      content.title ||
      content.selectedButtonId;
    const isResponse = (msg.messageType || '').toLowerCase().includes('response');

    if (isResponse && chosen) {
      return {
        interactive: { type: 'button', buttonId: msg.buttonOrListid || undefined },
        text: String(chosen),
      };
    }

    const question = (content.contentText || content.description || msg.text || '').trim();
    const options: string[] = [
      ...(content.buttons ?? []).map(
        (b: any) => b?.buttonText?.displayText || b?.displayText,
      ),
      ...(content.sections ?? []).flatMap((s: any) =>
        (s?.rows ?? []).map((r: any) => r?.title),
      ),
    ]
      .filter(Boolean)
      .map((o: string) => `• ${o}`);

    const text = [question, ...options].filter(Boolean).join('\n');
    return {
      interactive: { type: content.sections ? 'list' : 'button' },
      text: text || '[menu]',
    };
  }

  private formatContact(content: any, msg: any): string {
    const vcard: string = content.vcard || '';
    const name =
      content.displayName ||
      vcard.match(/^FN:(.+)$/m)?.[1]?.trim() ||
      'sem nome';
    const phones = [...vcard.matchAll(/^(?:item\d*\.)?TEL[^:]*:(.+)$/gm)]
      .map((m) => m[1].trim())
      .filter(Boolean);
    if (!vcard && !content.displayName) return msg.text || '[Contato]';
    return [`Contato: ${name}`, ...phones].join('\n');
  }

  private formatPoll(content: any, msg: any): string {
    const vote = typeof msg?.vote === 'string' ? msg.vote.trim() : '';
    if (vote) return `Votou: ${vote}`;

    const poll =
      content.pollCreationMessageV3 ||
      content.pollCreationMessage ||
      content.pollCreationMessageV2 ||
      {};
    const question = (poll.name || msg.text || '').trim();
    const options = (poll.options || [])
      .map((o: any) => o?.optionName)
      .filter(Boolean)
      .map((o: string) => `• ${o}`);
    return [`Enquete: ${question}`, ...options].join('\n');
  }

  private formatAlbum(content: any): string {
    const imgs = Number(content.expectedImageCount) || 0;
    const vids = Number(content.expectedVideoCount) || 0;
    const parts: string[] = [];
    if (imgs) parts.push(`${imgs} ${imgs === 1 ? 'imagem' : 'imagens'}`);
    if (vids) parts.push(`${vids} ${vids === 1 ? 'vídeo' : 'vídeos'}`);
    return `Álbum com ${parts.join(' e ') || 'mídias'}`;
  }

  private extractTemplateButtons(content: any): TemplateButton[] {
    const hydrated =
      content?.Format?.HydratedFourRowTemplate?.hydratedButtons ||
      content?.hydratedTemplate?.hydratedButtons ||
      content?.hydratedButtons ||
      [];
    return hydrated
      .map((entry: any) => {
        const b = entry?.HydratedButton ?? entry;
        if (b?.QuickReplyButton) {
          return {
            type: 'quick_reply',
            title: b.QuickReplyButton.displayText || '',
            payload: b.QuickReplyButton.ID,
          };
        }
        if (b?.UrlButton) {
          return {
            type: 'url',
            title: b.UrlButton.displayText || '',
            url: b.UrlButton.URL || b.UrlButton.url,
          };
        }
        if (b?.CallButton) {
          return {
            type: 'call',
            title: b.CallButton.displayText || '',
            payload: b.CallButton.phoneNumber,
          };
        }
        return null;
      })
      .filter((b: TemplateButton | null): b is TemplateButton => !!b);
  }
}
