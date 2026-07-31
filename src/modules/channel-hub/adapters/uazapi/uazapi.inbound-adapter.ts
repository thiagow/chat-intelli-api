import { Injectable, Logger } from '@nestjs/common';
import { Channel, ChannelType } from '@prisma/client';
import * as crypto from 'crypto';
import {
  InboundChannelPort,
  ChannelLocator,
} from '../../ports/inbound-channel.port';
import {
  WebhookParseResult,
  VerificationResponse,
} from '../../ports/types';
import { UazapiMessageMapper } from './uazapi.message-mapper';

@Injectable()
export class UazapiInboundAdapter implements InboundChannelPort {
  readonly channelType = ChannelType.WHATSAPP_UAZAPI;
  private readonly logger = new Logger(UazapiInboundAdapter.name);

  constructor(private readonly mapper: UazapiMessageMapper) {}

  extractLocators(
    payload: unknown,
    headers: Record<string, string>,
  ): ChannelLocator[] {
    const event = (payload ?? {}) as Record<string, any>;
    const instanceId: string | undefined =
      event?.instance?.id ||
      event?.instanceId ||
      event?.instance_id ||
      event?.owner?.id ||
      event?.owner ||
      event?.sender ||
      undefined;
    const token =
      headers['x-webhook-token'] ||
      headers['token'] ||
      event?.token ||
      event?.instance?.token ||
      event?.instanceToken ||
      undefined;
    const locator: ChannelLocator = {};
    if (instanceId) locator.instanceId = String(instanceId);
    if (token) locator.token = String(token);
    return [locator];
  }

  matchesChannel(channel: Channel, locator: ChannelLocator): boolean {
    const config = (channel.config ?? {}) as Record<string, any>;

    if (locator.instanceId && config.instanceId) {
      return String(config.instanceId) === locator.instanceId;
    }

    if (locator.token && config.token) {
      return this.timingSafeEqualStr(String(config.token), String(locator.token));
    }

    if (channel.webhookSecret && locator.token) {
      return this.timingSafeEqualStr(channel.webhookSecret, String(locator.token));
    }

    // Sem hint de roteamento no payload e sem identificador no canal: não dá
    // pra distinguir múltiplas instâncias — melhor recusar do que arriscar
    // vazamento entre organizações.
    return false;
  }

  validateWebhook(
    headers: Record<string, string>,
    _rawBody: Buffer,
    webhookSecret?: string,
    channel?: Channel,
  ): boolean {
    if (!webhookSecret) return true;
    const headerToken = headers['x-webhook-token'] || headers['token'];
    const bodyToken = this.extractBodyToken(_rawBody);
    const candidate = headerToken || bodyToken;
    if (!candidate) return false;
    if (this.timingSafeEqualStr(webhookSecret, candidate)) return true;
    const channelToken = (channel?.config as any)?.token;
    if (channelToken && this.timingSafeEqualStr(String(channelToken), candidate)) {
      return true;
    }
    return false;
  }

  private extractBodyToken(rawBody: Buffer): string | undefined {
    try {
      const json = JSON.parse(rawBody.toString('utf8')) as Record<string, any>;
      return json?.token || json?.instance?.token || json?.instanceToken || undefined;
    } catch {
      return undefined;
    }
  }

  private timingSafeEqualStr(a: string, b: string): boolean {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    try {
      return crypto.timingSafeEqual(ba, bb);
    } catch {
      return false;
    }
  }

  parseWebhook(payload: unknown, _channel?: Channel): WebhookParseResult {
    const result: WebhookParseResult = {
      messages: [],
      statuses: [],
      errors: [],
    };

    try {
      const event = payload as any;
      const eventType = event?.EventType || event?.event;

      if (eventType === 'messages' || eventType === 'messages.upsert') {
        const normalized = this.mapper.normalizeInbound(event);
        if (normalized) {
          result.messages.push(normalized);
        }
      } else if (eventType === 'messages_update' || eventType === 'messages.update') {
        const status = this.mapper.normalizeStatus(event);
        if (status) {
          result.statuses.push(status);
        }
      }
    } catch (error: any) {
      this.logger.error(`Failed to parse Uazapi webhook: ${error.message}`);
      result.errors.push({
        code: 'PARSE_ERROR',
        message: error.message,
        rawData: payload,
      });
    }

    return result;
  }

  handleVerification(
    _query: Record<string, string>,
    _webhookSecret?: string,
  ): VerificationResponse {
    return { statusCode: 200, body: 'OK' };
  }
}
