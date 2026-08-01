import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../../database/prisma.module';
import { LlmModule } from '../llm/llm.module';
import { EmbeddingsService } from './embeddings.service';
import { VectorStoreService } from './vector-store.service';
import { RetrievalService } from './retrieval.service';
import { RerankerService } from './reranker.service';
import { RagIndexerProcessor } from './indexer.processor';
import { PdfExtractorService } from './pdf-extractor';
import { KnowledgeIndexerProcessor } from './knowledge-indexer.processor';

/**
 * RAG (Retrieval-Augmented Generation) module.
 *
 * Wires up:
 *  - `EmbeddingsService`           OpenAI embeddings (text-embedding-3-small)
 *  - `VectorStoreService`          Postgres + pgvector raw SQL via Prisma
 *  - `RetrievalService`            embed → search → optional rerank
 *  - `RerankerService`             Fugu-based relevance re-ranker (optional)
 *  - `PdfExtractorService`         PDF text extraction (unpdf)
 *  - `RagIndexerProcessor`         BullMQ worker on `rag-indexer` queue (messages/facts)
 *  - `KnowledgeIndexerProcessor`   BullMQ worker on `knowledge-indexer` queue (documents)
 *
 * NOTE: the `ai_vector_entries` table + pgvector extension are created
 * via migration. The `knowledge_sources` table is modeled in prisma.schema.
 *
 * Exports the high-level services so the agent runner / prompt composer
 * can call `RetrievalService.retrieve(...)` from Layer 4 CONTEXT.
 */
const ragIndexerQueue = BullModule.registerQueue({ name: 'rag-indexer' });
const knowledgeIndexerQueue = BullModule.registerQueue({ name: 'knowledge-indexer' });

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    LlmModule,
    ragIndexerQueue,
    knowledgeIndexerQueue,
  ],
  providers: [
    EmbeddingsService,
    VectorStoreService,
    RerankerService,
    RetrievalService,
    PdfExtractorService,
    RagIndexerProcessor,
    KnowledgeIndexerProcessor,
  ],
  exports: [
    EmbeddingsService,
    VectorStoreService,
    RetrievalService,
    RerankerService,
    PdfExtractorService,
    // Re-export queue registrations so modules that import RagModule
    // (ex: AiAgentsModule, KnowledgeModule) can @InjectQueue(...).
    ragIndexerQueue,
    knowledgeIndexerQueue,
  ],
})
export class RagModule {}
