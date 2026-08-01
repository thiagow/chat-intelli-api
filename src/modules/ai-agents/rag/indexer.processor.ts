import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { EmbeddingsService } from './embeddings.service';
import { VectorStoreService } from './vector-store.service';
import type { IndexerJobData, SearchScope, VectorEntry, VectorOwnerType } from './types';

/**
 * Background worker that turns domain rows (messages, facts, memory
 * summaries) into vector entries.
 *
 * The agent runner enqueues a job whenever it persists a new message
 * or fact, so indexing happens off the hot path. Concurrency=4 is a
 * safe starting point — OpenAI embeddings handle bursts well, and the
 * pgvector inserts are cheap.
 *
 * Job payload shapes are in `types.ts → IndexerJobData`.
 */
@Processor('rag-indexer', { concurrency: 4 })
export class RagIndexerProcessor extends WorkerHost {
  private readonly logger = new Logger(RagIndexerProcessor.name);

  constructor(
    private readonly embeddings: EmbeddingsService,
    private readonly store: VectorStoreService,
  ) {
    super();
  }

  async process(job: Job<IndexerJobData>): Promise<{ ok: true } | { ok: false; reason: string }> {
    const data = job.data;

    try {
      switch (data.type) {
        case 'index_message':
          await this.index('message', data.messageId, data.content, data.scope, data.metadata);
          return { ok: true };

        case 'index_fact':
          await this.index('fact', data.factId, data.content, data.scope, data.metadata);
          return { ok: true };

        case 'index_memory_summary':
          await this.index(
            'memory_summary',
            data.summaryId,
            data.content,
            data.scope,
            data.metadata,
          );
          return { ok: true };

        case 'delete_entry':
          await this.store.delete(data.id);
          this.logger.log(`rag_indexer_deleted id=${data.id}`);
          return { ok: true };

        default: {
          const exhaustive: never = data;
          this.logger.warn(`rag_indexer_unknown_job ${JSON.stringify(exhaustive)}`);
          return { ok: false, reason: 'unknown_job_type' };
        }
      }
    } catch (err) {
      const reason = (err as Error)?.message ?? String(err);
      this.logger.error(`rag_indexer_failed jobId=${job.id} reason=${reason}`);
      // Re-throw so BullMQ records the failure and retries per the queue's
      // configured backoff. We don't want to swallow embedding outages.
      throw err;
    }
  }

  private async index(
    ownerType: VectorOwnerType,
    ownerId: string,
    content: string,
    scope: SearchScope,
    metadata?: Record<string, any>,
  ): Promise<void> {
    if (!content || content.trim().length === 0) {
      this.logger.debug(`rag_indexer_skip_empty ownerType=${ownerType} ownerId=${ownerId}`);
      return;
    }

    const emb = await this.embeddings.embed(content);

    const entry: VectorEntry = {
      id: `${ownerType}:${ownerId}`,
      ownerType,
      ownerId,
      organizationId: scope.organizationId,
      conversationId: scope?.conversationId,
      agentId: scope?.agentId,
      contactId: scope?.contactId,
      content,
      embedding: emb.vector,
      metadata: {
        ...(metadata ?? {}),
        embeddingModel: emb.model,
        embeddingTokens: emb.tokensUsed,
        embeddingCostUsd: emb.costUsd,
      },
      createdAt: new Date().toISOString(),
    };

    await this.store.upsert(entry);

    this.logger.log(
      `rag_indexed ownerType=${ownerType} ownerId=${ownerId} tokens=${emb.tokensUsed} costUsd=${emb.costUsd.toFixed(6)}`,
    );
  }
}
