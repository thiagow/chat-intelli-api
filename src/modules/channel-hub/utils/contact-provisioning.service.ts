import { Injectable, Logger } from '@nestjs/common';
import { ChannelType, Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { toWhatsappExternalId } from './whatsapp-jid';

export interface ProvisionContactInput {
  phone: string;
  name?: string | null;
  email?: string | null;
  /** Merge raso em `Contact.metadata` ao CRIAR (ex.: companyName). */
  metadata?: Record<string, unknown>;
  /**
   * JID já verificado pelo provider (ex.: `/chat/check`). Quando informado, é
   * usado como `externalId` em vez de derivar do telefone.
   */
  externalId?: string;
}

export interface ProvisionedContact {
  contactId: string;
  externalId: string;
}

/**
 * Cria/garante `Contact` + `ContactChannel` para um telefone num canal, no
 * formato de external id que o INBOUND daquele canal grava (senão duplica o
 * contato quando a pessoa responde). Extraído do RecoveryOutreachService para
 * ser compartilhado com as campanhas.
 */
@Injectable()
export class ContactProvisioningService {
  private readonly logger = new Logger(ContactProvisioningService.name);

  constructor(private readonly prisma: PrismaService) {}

  async provision(
    organizationId: string,
    channelId: string,
    channelType: ChannelType | null,
    data: ProvisionContactInput,
  ): Promise<ProvisionedContact> {
    const externalId = data.externalId ?? toWhatsappExternalId(channelType, data.phone);

    // 1. Já existe vínculo nesse canal?
    const existingChannel = await this.prisma.contactChannel.findUnique({
      where: { uq_contact_channel_external: { channelId, externalId } },
      select: { contactId: true },
    });
    if (existingChannel) return { contactId: existingChannel.contactId, externalId };

    // 2. Existe um Contact com esse telefone (de outro canal)? Reaproveita.
    const existingContact = await this.prisma.contact.findFirst({
      where: { organizationId, phone: data.phone, deletedAt: null },
      select: { id: true },
    });

    try {
      if (existingContact) {
        await this.prisma.contactChannel.create({
          data: {
            contactId: existingContact.id,
            channelId,
            externalId,
            profileName: data.name ?? undefined,
          },
        });
        return { contactId: existingContact.id, externalId };
      }

      const contact = await this.prisma.contact.create({
        data: {
          organizationId,
          name: data.name ?? undefined,
          phone: data.phone,
          email: data.email ?? undefined,
          ...(data.metadata && { metadata: data.metadata as Prisma.InputJsonValue }),
          channels: {
            create: { channelId, externalId, profileName: data.name ?? undefined },
          },
        },
        select: { id: true },
      });
      this.logger.log(`Contato provisionado: ${contact.id} (${data.phone})`);
      return { contactId: contact.id, externalId };
    } catch (err) {
      // Corrida: outro webhook criou o vínculo no meio. Re-busca.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const racer = await this.prisma.contactChannel.findUnique({
          where: { uq_contact_channel_external: { channelId, externalId } },
          select: { contactId: true },
        });
        if (racer) return { contactId: racer.contactId, externalId };
      }
      throw err;
    }
  }
}
