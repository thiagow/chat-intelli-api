import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import {
  CONTACT_LOCK_TTL_MS,
} from '../automations.constants';

// Thin wrapper around an ioredis connection dedicated to the automation
// engine. Kept separate from the BullMQ connection so a stuck Lua eval
// here doesn't interfere with the queue.
//
// Why ioredis directly and not a 3rd-party lock library? Because the
// surface we need is tiny (SET NX PX + Lua-based release) and adding a
// dependency for 30 lines of Lua is silly.
@Injectable()
export class AutomationRedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AutomationRedisService.name);
  private redis!: Redis;

  // Atomic release: only delete the key if our token still owns the lock.
  // Without this, a slow worker whose lease expired could delete a lock
  // that another worker has already re-acquired.
  private static readonly RELEASE_LUA = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.redis = new Redis({
      host: this.config.get<string>('redis.host', 'localhost'),
      port: this.config.get<number>('redis.port', 6379),
      password: this.config.get<string>('redis.password') || undefined,
      tls: this.config.get<boolean>('redis.tls') ? {} : undefined,
      // Don't queue commands for an unreachable Redis — fail fast so the
      // executor falls back to "skip with redis_unavailable" and we don't
      // silently stall every event waiting for a dead Redis.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      lazyConnect: false,
    });
    this.redis.on('error', (err) => {
      this.logger.error(`Redis error: ${err.message}`);
    });
  }

  async onModuleDestroy() {
    if (this.redis) await this.redis.quit().catch(() => undefined);
  }

  // Acquire a per-contact lock. Returns the unlock token on success, null
  // on failure (already held). Caller MUST always call `release` even if
  // its work threw — finally block is mandatory.
  async acquireContactLock(contactId: string): Promise<string | null> {
    const key = `automation:lock:contact:${contactId}`;
    const token = randomUUID();
    const result = await this.redis.set(
      key,
      token,
      'PX',
      CONTACT_LOCK_TTL_MS,
      'NX',
    );
    return result === 'OK' ? token : null;
  }

  async releaseContactLock(contactId: string, token: string): Promise<void> {
    const key = `automation:lock:contact:${contactId}`;
    await this.redis
      .eval(AutomationRedisService.RELEASE_LUA, 1, key, token)
      .catch((err) =>
        this.logger.warn(`lock release failed for ${contactId}: ${err.message}`),
      );
  }

  // Sliding-window rate limit over 60s. Returns true if the request fits
  // under the limit and was counted; false if the window is full.
  //
  // Implementation: Redis sorted set per (automation, conversation). Each
  // call adds a member at score=now, drops members older than 60s, and
  // checks size. ZADD+ZREMRANGEBYSCORE+ZCARD in a pipeline is atomic
  // enough for our needs (and orders of magnitude cheaper than a Lua
  // script for the volumes we're talking about).
  async tryConsumeRateLimit(
    automationId: string,
    conversationId: string | null | undefined,
    perMinute: number,
  ): Promise<boolean> {
    if (!conversationId) return true; // no conversation = no per-conv limit
    if (perMinute <= 0) return true;

    const key = `automation:rate:${automationId}:${conversationId}`;
    const now = Date.now();
    const windowMs = 60_000;
    const member = `${now}-${randomUUID().slice(0, 6)}`;

    const pipeline = this.redis.pipeline();
    pipeline.zremrangebyscore(key, 0, now - windowMs);
    pipeline.zadd(key, now, member);
    pipeline.zcard(key);
    pipeline.pexpire(key, windowMs * 2);
    const results = await pipeline.exec();
    if (!results) return true; // be permissive on Redis hiccups

    const card = Number(results[2]?.[1] ?? 0);
    if (card > perMinute) {
      // Roll back our own contribution so the next caller doesn't see an
      // inflated count and reject themselves spuriously.
      await this.redis.zrem(key, member).catch(() => undefined);
      return false;
    }
    return true;
  }
}
