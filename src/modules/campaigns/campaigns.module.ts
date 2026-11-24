import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ChannelHubModule } from '../channel-hub/channel-hub.module';
import { ContactProvisioningService } from '../channel-hub/utils/contact-provisioning.service';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';
import { CampaignsEngine } from './campaigns.engine';
import { CampaignsProcessor } from './campaigns.processor';
import { ReplyWebhookService } from './reply-webhook.service';
import { CAMPAIGNS_QUEUE } from './campaigns.constants';

/**
 * Campanhas de WhatsApp em massa (v1: UaZAPI). Não importa o MessagingModule:
 * o rastreio de echo/resposta vive em `CampaignTrackingModule`, que o
 * messaging importa — assim não há ciclo.
 */
@Module({
  imports: [BullModule.registerQueue({ name: CAMPAIGNS_QUEUE }), ChannelHubModule],
  controllers: [CampaignsController],
  providers: [CampaignsService, CampaignsEngine, CampaignsProcessor, ReplyWebhookService, ContactProvisioningService],
})
export class CampaignsModule {}
