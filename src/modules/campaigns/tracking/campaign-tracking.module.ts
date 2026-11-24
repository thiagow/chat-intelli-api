import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CAMPAIGNS_QUEUE } from '../campaigns.constants';
import { CampaignTrackingService } from './campaign-tracking.service';

/**
 * Módulo mínimo (só Prisma + Realtime, ambos globais) para o MessagingModule
 * importar sem criar ciclo com o módulo de campanhas.
 */
@Module({
  // Só PRODUTOR da fila: o único @Processor de `campaigns` continua no CampaignsModule.
  imports: [BullModule.registerQueue({ name: CAMPAIGNS_QUEUE })],
  providers: [CampaignTrackingService],
  exports: [CampaignTrackingService],
})
export class CampaignTrackingModule {}
