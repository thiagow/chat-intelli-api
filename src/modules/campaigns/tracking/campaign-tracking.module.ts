import { Module } from '@nestjs/common';
import { CampaignTrackingService } from './campaign-tracking.service';

/**
 * Módulo mínimo (só Prisma + Realtime, ambos globais) para o MessagingModule
 * importar sem criar ciclo com o módulo de campanhas.
 */
@Module({
  providers: [CampaignTrackingService],
  exports: [CampaignTrackingService],
})
export class CampaignTrackingModule {}
