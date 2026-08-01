import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../../database/prisma.service';
import { EmbeddingsService } from './embeddings.service';
import { VectorStoreService } from './vector-store.service';
import { PdfExtractorService } from './pdf-extractor';
import { chunkText } from './chunker';
import type { VectorEntry } from './types';

/**
 * Job payload for knowledge indexing.
 *
 * Knowledge sources (documents) are chunked, embedded, and stored in the
 * vector database for retrieval during agent context building.
 */
export interface KnowledgeIndexerJobData {
  type: 'index_knowledge';
  sourceId: string;
  organizationId: string;
  agentId?: string | null;
  content: string;
  isPdf?: boolean;
}

/**
 * Background worker for knowledge base indexing.
 *
 * Pipeline:
 * 1. Extract text from PDF (if needed)
 * 2. Split into chunks
 * 3. Embed chunks in batch
 * 4. Upsert to vector store
 * 5. Update KnowledgeSource status
 */
@Processor('knowledge-indexer', { concurrency: 2 })
export class KnowledgeIndexerProcessor extends WorkerHost {
  private readonly logger = new Logger(KnowledgeIndexerProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pdfExtractor: PdfExtractorService,
    private readonly embeddings: EmbeddingsService,
    private readonly store: VectorStoreService,
  ) {
    super();
  }

  async process(job: Job<KnowledgeIndexerJobData>): Promise<void> {
    const { sourceId, organizationId, agentId, content, isPdf } = job.data;

    try {
      // Mark as processing
      await this.prisma.knowledgeSource.update({
        where: { id: sourceId },
        data: { status: 'PROCESSING' },
      });

      // Extract text from PDF if needed
      let text = content;
      if (isPdf) {
        const buffer = Buffer.from(content, 'base64');
        text = await this.pdfExtractor.extractText(buffer, `knowledge_${sourceId}.pdf`);
      }

      // Chunk text
      const chunks = chunkText(text);

      if (chunks.length === 0) {
        await this.prisma.knowledgeSource.update({
          where: { id: sourceId },
          data: {
            status: 'FAILED',
            errorMessage: 'Nenhum conteúdo extraível foi encontrado.',
          },
        });
        return;
      }

      // Extract chunk texts for batch embedding
      const chunkTexts = chunks.map((c) => c.text);

      // Embed all chunks in one batch
      const embeddings = await this.embeddings.embedBatch(chunkTexts);

      // Build vector entries for upsert
      const entries: VectorEntry[] = chunks.map((chunk, idx) => {
        const emb = embeddings[idx];
        return {
          id: `knowledge:${sourceId}:${chunk.index}`,
          ownerType: 'knowledge',
          ownerId: sourceId,
          organizationId,
          agentId: agentId ?? undefined,
          content: chunk.text,
          embedding: emb.vector,
          metadata: {
            embeddingModel: emb.model,
            embeddingTokens: emb.tokensUsed,
            embeddingCostUsd: emb.costUsd,
          },
          createdAt: new Date().toISOString(),
        };
      });

      // Upsert all entries
      await this.store.upsertMany(entries);

      // Mark as ready
      await this.prisma.knowledgeSource.update({
        where: { id: sourceId },
        data: {
          status: 'READY',
          chunkCount: chunks.length,
        },
      });

      this.logger.log(
        `knowledge_indexed sourceId=${sourceId} chunks=${chunks.length} ` +
          `organizationId=${organizationId} agentId=${agentId ?? 'org-wide'}`,
      );
    } catch (error: unknown) {
      const reason =
        error instanceof Error ? error.message : String(error);

      this.logger.error(
        `knowledge_indexing_failed sourceId=${sourceId} reason=${reason}`,
      );

      // Mark source as failed
      await this.prisma.knowledgeSource
        .update({
          where: { id: sourceId },
          data: {
            status: 'FAILED',
            errorMessage: reason,
          },
        })
        .catch((err) => {
          this.logger.error(
            `Could not update KnowledgeSource status: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });

      // Re-throw so BullMQ can retry
      throw error;
    }
  }
}

/**
 * Export constant for the queue name so it can be reused elsewhere
 * without hardcoding the string.
 */
export const KNOWLEDGE_INDEXER_QUEUE = 'knowledge-indexer';
