import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ChannelType } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { ZappfyContactEnricherService } from '../adapters/zappfy/zappfy-contact-enricher.service';
import { UazapiContactEnricherService } from '../adapters/uazapi/uazapi-contact-enricher.service';
import {
  AVATAR_HYDRATION_QUEUE,
  type AvatarHydrationJob,
} from './avatar-hydration.constants';

/**
 * Busca a foto de perfil de um contato/grupo fora do caminho da requisição.
 *
 * `concurrency: 1` é de propósito: o espaçamento entre as fotos é o que
 * mantém o provider feliz, e nada disso é urgente — foto é enfeite, então
 * qualquer falha aqui só significa que a UI segue com as iniciais.
 *
 * Único worker pra fila, compartilhado entre providers WhatsApp não-oficiais
 * (Zappfy e Uazapi — mesmo motor, mesma lógica de cache). Registrar um
 * segundo @Processor pro mesmo nome de fila em outro módulo criaria dois
 * workers concorrentes consumindo os mesmos jobs — por isso o dispatch é
 * feito aqui dentro por `channel.type`, e não duplicando este processor.
 */
@Processor(AVATAR_HYDRATION_QUEUE, { concurrency: 1 })
export class AvatarHydrationProcessor extends WorkerHost {
  private readonly logger = new Logger(AvatarHydrationProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly zappfyEnricher: ZappfyContactEnricherService,
    private readonly uazapiEnricher: UazapiContactEnricherService,
  ) {
    super();
  }

  async process(job: Job<AvatarHydrationJob>): Promise<void> {
    const { channelId, externalContactId, force, maxAgeDays } = job.data;

    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, deletedAt: null },
    });
    if (!channel) return;

    const enricher =
      channel.type === ChannelType.WHATSAPP_ZAPPFY
        ? this.zappfyEnricher
        : channel.type === ChannelType.WHATSAPP_UAZAPI
          ? this.uazapiEnricher
          : null;
    if (!enricher) return;

    await enricher.enrich(channel, externalContactId, { force, maxAgeDays });
  }

  async onFailed(job: Job<AvatarHydrationJob>, err: Error): Promise<void> {
    this.logger.debug(
      `Hidratação de avatar falhou (${job?.data?.externalContactId}): ${err.message}`,
    );
  }
}
