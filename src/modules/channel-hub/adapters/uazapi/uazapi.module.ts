import { Module, forwardRef } from '@nestjs/common';
import { UazapiInboundAdapter } from './uazapi.inbound-adapter';
import { UazapiOutboundAdapter } from './uazapi.outbound-adapter';
import { UazapiMessageMapper } from './uazapi.message-mapper';
import { UazapiHttpClient } from './uazapi.http-client';
import { UazapiSyncAdapter } from './uazapi.sync-adapter';
import { UazapiContactEnricherService } from './uazapi-contact-enricher.service';
import { MessagingModule } from '../../../messaging/messaging.module';

/**
 * Nota: NÃO registra AvatarHydrationProcessor nem BullModule.registerQueue
 * pra AVATAR_HYDRATION_QUEUE aqui — esse worker já existe uma única vez no
 * ZappfyModule (mesma fila compartilhada entre providers WhatsApp não-
 * oficiais) e foi generalizado em avatar-hydration.processor.ts pra
 * despachar por channel.type. Registrar de novo aqui criaria um segundo
 * worker concorrente na mesma fila.
 */
@Module({
  imports: [
    forwardRef(() => MessagingModule),
  ],
  providers: [
    UazapiInboundAdapter,
    UazapiOutboundAdapter,
    UazapiMessageMapper,
    UazapiHttpClient,
    UazapiSyncAdapter,
    UazapiContactEnricherService,
  ],
  exports: [
    UazapiInboundAdapter,
    UazapiOutboundAdapter,
    UazapiHttpClient,
    UazapiSyncAdapter,
    UazapiContactEnricherService,
  ],
})
export class UazapiModule {}
