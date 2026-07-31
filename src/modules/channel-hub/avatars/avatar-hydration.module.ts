import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AvatarHydrationProcessor } from './avatar-hydration.processor';
import { AVATAR_HYDRATION_QUEUE } from './avatar-hydration.constants';
import { ZappfyModule } from '../adapters/zappfy/zappfy.module';
import { UazapiModule } from '../adapters/uazapi/uazapi.module';

/**
 * AvatarHydrationProcessor is shared across both WhatsApp-web-style
 * providers (Zappfy, Uazapi) and dispatches by channel.type internally —
 * see avatar-hydration.processor.ts. It needs to live in its own module
 * that imports both providers' enricher services, since NestJS won't
 * resolve a provider's constructor dependency across sibling modules
 * without an explicit import (this used to live inside ZappfyModule, which
 * broke the moment the processor also started depending on
 * UazapiContactEnricherService).
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: AVATAR_HYDRATION_QUEUE }),
    ZappfyModule,
    UazapiModule,
  ],
  providers: [AvatarHydrationProcessor],
})
export class AvatarHydrationModule {}
