import { Injectable, Logger } from '@nestjs/common';
import { Channel } from '@prisma/client';
import { PrismaService } from '../../../../database/prisma.service';
import { UazapiHttpClient } from './uazapi.http-client';
import { UploadsService } from '../../../messaging/messages/uploads.service';
import { RealtimeGateway } from '../../../realtime/realtime.gateway';

/**
 * Pulls profile picture (and best-effort name) for a WhatsApp contact via
 * the Uazapi `/chat/find` + `/chat/details` endpoints. Mirrors
 * ZappfyContactEnricherService's caching strategy exactly (same underlying
 * engine, same quirks expected).
 */
@Injectable()
export class UazapiContactEnricherService {
  private readonly logger = new Logger(UazapiContactEnricherService.name);
  private static readonly AVATAR_TTL_DAYS = 7;
  private static readonly NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpClient: UazapiHttpClient,
    private readonly uploads: UploadsService,
    private readonly realtime: RealtimeGateway,
  ) {}

  async enrich(
    channel: Channel,
    externalContactId: string,
    options: { force?: boolean; maxAgeDays?: number } = {},
  ): Promise<void> {
    const force = options.force ?? false;
    const maxAgeDays =
      options.maxAgeDays ?? UazapiContactEnricherService.AVATAR_TTL_DAYS;
    try {
      const contactChannel = await this.prisma.contactChannel.findUnique({
        where: {
          uq_contact_channel_external: {
            channelId: channel.id,
            externalId: externalContactId,
          },
        },
        include: { contact: true },
      });
      if (!contactChannel) return;

      const ageDays = await this.uploads.avatarAgeInDays(
        contactChannel.contact.avatarUrl,
      );
      const stale = ageDays === null || ageDays > maxAgeDays;
      if (contactChannel.contact.avatarUrl && !stale && !force) return;

      const metadata = (contactChannel.contact.metadata ?? {}) as Record<string, any>;
      const checkedAt = metadata.avatarCheckedAt
        ? new Date(metadata.avatarCheckedAt).getTime()
        : 0;
      const checkedRecently =
        Date.now() - checkedAt < UazapiContactEnricherService.NEGATIVE_TTL_MS;
      if (!contactChannel.contact.avatarUrl && checkedRecently && !force) return;

      await this.prisma.contact.update({
        where: { id: contactChannel.contactId },
        data: { metadata: { ...metadata, avatarCheckedAt: new Date().toISOString() } },
      });

      const chat = await this.fetchChat(channel, externalContactId);
      if (!chat) return;

      const profileName: string | undefined =
        chat.wa_contactName || chat.wa_name || undefined;
      const avatarUrl = await this.downloadAvatar(
        channel,
        externalContactId,
        contactChannel.contactId,
      );

      if (!avatarUrl && !profileName) return;

      const ccUpdates: Record<string, any> = {};
      if (profileName && profileName !== contactChannel.profileName) {
        ccUpdates.profileName = profileName;
      }
      if (avatarUrl && avatarUrl !== contactChannel.profileAvatarUrl) {
        ccUpdates.profileAvatarUrl = avatarUrl;
      }
      if (Object.keys(ccUpdates).length > 0) {
        await this.prisma.contactChannel.update({
          where: { id: contactChannel.id },
          data: ccUpdates,
        });
      }

      const contactUpdates: Record<string, any> = {};
      if (profileName && !contactChannel.contact.name) {
        contactUpdates.name = profileName;
      }
      if (avatarUrl && avatarUrl !== contactChannel.contact.avatarUrl) {
        contactUpdates.avatarUrl = avatarUrl;
      }
      if (Object.keys(contactUpdates).length > 0) {
        await this.prisma.contact.update({
          where: { id: contactChannel.contactId },
          data: contactUpdates,
        });
      }

      if (contactUpdates.avatarUrl) {
        this.realtime.emitToOrg(
          contactChannel.contact.organizationId,
          'contact:avatar',
          {
            contactId: contactChannel.contactId,
            avatarUrl: contactUpdates.avatarUrl,
            name: contactUpdates.name ?? contactChannel.contact.name ?? null,
          },
        );
      }

      this.logger.log(
        `Uazapi contact enriched: ${externalContactId} → ${profileName ?? '(no name)'} ${avatarUrl ? '+ avatar' : ''}`,
      );
    } catch (err: any) {
      this.logger.warn(
        `Uazapi contact enrichment failed for ${externalContactId}: ${err.message}`,
      );
    }
  }

  private async downloadAvatar(
    channel: Channel,
    externalContactId: string,
    contactId: string,
  ): Promise<string | undefined> {
    try {
      const { url } = await this.httpClient.fetchProfilePicture(
        channel,
        externalContactId.replace(/@s\.whatsapp\.net$/, ''),
      );
      if (!url) return undefined;
      const buffer = await this.httpClient.getMediaBuffer(channel, url);
      if (!buffer?.byteLength) return undefined;
      return await this.uploads.saveAvatar({
        key: contactId,
        buffer,
        mimeType: 'image/jpeg',
      });
    } catch (err: any) {
      this.logger.debug(`Sem avatar pra ${externalContactId}: ${err.message}`);
      return undefined;
    }
  }

  private async fetchChat(channel: Channel, chatId: string): Promise<any | null> {
    try {
      const response = await this.httpClient.sendRequest(channel, '/chat/find', {
        wa_chatid: chatId,
        limit: 1,
      });
      const chats = response?.chats ?? response?.data ?? response;
      return Array.isArray(chats) ? chats[0] : chats?.[0] ?? null;
    } catch (err: any) {
      this.logger.warn(`Uazapi fetchChat failed for ${chatId}: ${err.message}`);
      return null;
    }
  }
}
