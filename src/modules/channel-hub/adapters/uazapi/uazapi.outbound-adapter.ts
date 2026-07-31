import { Injectable, Logger } from '@nestjs/common';
import { ChannelType, Channel } from '@prisma/client';
import { OutboundChannelPort } from '../../ports/outbound-channel.port';
import {
  NormalizedOutboundMessage,
  SendResult,
  RateLimitConfig,
} from '../../ports/types';
import { UazapiMessageMapper } from './uazapi.message-mapper';
import { UazapiHttpClient } from './uazapi.http-client';

@Injectable()
export class UazapiOutboundAdapter implements OutboundChannelPort {
  readonly channelType = ChannelType.WHATSAPP_UAZAPI;
  private readonly logger = new Logger(UazapiOutboundAdapter.name);

  constructor(
    private readonly mapper: UazapiMessageMapper,
    private readonly httpClient: UazapiHttpClient,
  ) {}

  async sendMessage(
    channel: Channel,
    contactExternalId: string,
    message: NormalizedOutboundMessage,
  ): Promise<SendResult> {
    const { endpoint, payload } = this.mapper.denormalize(message, contactExternalId);

    const response = await this.httpClient.sendRequest(channel, endpoint, payload);

    return {
      externalId: response?.messageid || response?.key?.id || response?.id || '',
      providerResponse: response,
    };
  }

  async sendTypingIndicator(
    channel: Channel,
    contactExternalId: string,
  ): Promise<void> {
    const number = contactExternalId.replace(/@s\.whatsapp\.net|@g\.us/g, '');
    try {
      await this.httpClient.sendRequest(channel, '/send/presence', {
        number,
        presence: 'composing',
      });
    } catch (error: any) {
      this.logger.warn(`Typing indicator failed: ${error.message}`);
    }
  }

  async getMediaUrl(channel: Channel, mediaId: string): Promise<string> {
    return mediaId;
  }

  async downloadMedia(channel: Channel, mediaId: string): Promise<Buffer> {
    return this.httpClient.getMediaBuffer(channel, mediaId);
  }

  async resolveInboundMediaUrl(
    channel: Channel,
    hint: { externalMessageId: string },
  ): Promise<{ fileUrl: string; mimeType?: string }> {
    return this.httpClient.resolveInboundMediaUrl(channel, hint.externalMessageId);
  }

  async deleteMessage(
    channel: Channel,
    externalMessageId: string,
  ): Promise<void> {
    await this.httpClient.deleteMessage(channel, externalMessageId);
  }

  /**
   * A documentação da Uazapi menciona `readchat`/`readmessages` como params
   * de qualquer `/send/*` e também endpoints dedicados em "Chats" pra marcar
   * como lido, mas o path exato não foi confirmado contra uma conta real
   * (docs.uazapi.com é uma SPA — não foi possível extrair a rota exata).
   * NÃO implementado como no-op silencioso de propósito: deixamos undefined
   * (o port já trata isso via optional chaining) até validar o endpoint real
   * com uma conta de teste — inventar um path aqui seria repetir o tipo de
   * bug de "campo/rota errada" que já mordeu a integração Zappfy várias vezes.
   */

  getRateLimits(): RateLimitConfig {
    return {
      maxPerSecond: 1,
      maxPerMinute: 30,
      windowMs: 60000,
    };
  }
}
