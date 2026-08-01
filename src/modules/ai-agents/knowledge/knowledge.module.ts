import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../database/prisma.module';
import { RagModule } from '../rag/rag.module';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeRepository } from './knowledge.repository';

/**
 * Knowledge Base (RAG documents) module.
 *
 * Exposes:
 * - POST /knowledge — create text knowledge
 * - POST /knowledge/upload — upload PDF
 * - GET /knowledge — list sources
 * - GET /knowledge/:id — get detail
 * - DELETE /knowledge/:id — delete source
 * - POST /knowledge/:id/reindex — reprocess
 *
 * Wires up document ingestion (extraction, chunking, embedding, vector storage).
 */
@Module({
  imports: [
    PrismaModule,
    RagModule, // For embeddings, vector store, PDF extraction, and knowledge-indexer queue
  ],
  controllers: [KnowledgeController],
  providers: [
    KnowledgeService,
    KnowledgeRepository,
  ],
  exports: [
    KnowledgeService,
    KnowledgeRepository,
  ],
})
export class KnowledgeModule {}
