import { FactoryProvider, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Local Redis client provider for the short-term memory service.
 *
 * The rest of the codebase currently instantiates `new Redis(...)` per
 * service (see `IdempotencyService`, `PresenceService`, ...). When/if a
 * shared `RedisModule` is introduced, this provider should be deleted and
 * `ShortTermMemoryService` should consume the global `REDIS_CLIENT` token.
 */
export const REDIS_CLIENT_TOKEN = 'SHORT_TERM_REDIS_CLIENT';

export const redisProvider: FactoryProvider<Redis> = {
  provide: REDIS_CLIENT_TOKEN,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Redis => {
    const logger = new Logger('ShortTermRedisProvider');
    const client = new Redis({
      host: config.get<string>('REDIS_HOST', 'localhost'),
      port: config.get<number>('REDIS_PORT', 6379),
      password: config.get<string>('REDIS_PASSWORD') || undefined,
      tls: config.get<string>('REDIS_TLS') === 'true' ? {} : undefined,
      // Required for BullMQ / long-running blocking commands compatibility.
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: false,
    });

    client.on('error', (err) => {
      logger.error(`Redis error: ${err.message}`);
    });

    return client;
  },
};
