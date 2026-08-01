import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { KnowledgeRepository } from './knowledge.repository';
import { VectorStoreService } from '../rag/vector-store.service';
import { CreateKnowledgeDto } from './dto/create-knowledge.dto';
import { UploadKnowledgeDto } from './dto/upload-knowledge.dto';
import { KNOWLEDGE_INDEXER_QUEUE } from '../rag/knowledge-indexer.processor';

interface KnowledgeIndexerJobData {
  type: 'index_knowledge';
  sourceId: string;
  organizationId: string;
  agentId?: string | null;
  content: string;
  isPdf?: boolean;
}

@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(
    private readonly repository: KnowledgeRepository,
    private readonly vectorStore: VectorStoreService,
    @InjectQueue(KNOWLEDGE_INDEXER_QUEUE)
    private readonly knowledgeQueue: Queue<KnowledgeIndexerJobData>,
  ) {}

  /**
   * Create a text-based knowledge source and enqueue for indexing.
   */
  async createTextKnowledge(
    organizationId: string,
    dto: CreateKnowledgeDto,
  ) {
    const source = await this.repository.create({
      organizationId,
      agentId: dto.agentId,
      title: dto.title,
      sourceType: 'TEXT',
      content: dto.content,
    });

    // Enqueue for indexing with retry
    await this.knowledgeQueue.add(
      'index_knowledge',
      {
        type: 'index_knowledge',
        sourceId: source.id,
        organizationId,
        agentId: dto.agentId,
        content: dto.content,
        isPdf: false,
      } as KnowledgeIndexerJobData,
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
      },
    );

    this.logger.log(
      `knowledge_created sourceId=${source.id} type=TEXT organizationId=${organizationId}`,
    );

    return source;
  }

  /**
   * Upload a PDF-based knowledge source and enqueue for indexing.
   */
  async uploadPdfKnowledge(
    organizationId: string,
    dto: UploadKnowledgeDto,
    file: { buffer: Buffer; mimetype: string; originalname?: string; size?: number },
  ) {
    if (!file) {
      throw new BadRequestException('Arquivo PDF é obrigatório');
    }

    if (file.mimetype !== 'application/pdf') {
      throw new BadRequestException('Apenas arquivos PDF são aceitos');
    }

    // Store the PDF buffer as base64 in the content field for now
    // In production, you might store the file in S3/R2 and keep the URL
    const base64Content = file.buffer.toString('base64');

    const source = await this.repository.create({
      organizationId,
      agentId: dto.agentId,
      title: dto.title,
      sourceType: 'PDF',
      content: base64Content, // Store as base64 temporarily
      fileUrl: undefined, // Would be S3/R2 URL in production
      fileName: file.originalname,
      fileSize: file.size ?? file.buffer.length,
    });

    // Enqueue for PDF extraction + indexing
    await this.knowledgeQueue.add(
      'index_knowledge',
      {
        type: 'index_knowledge',
        sourceId: source.id,
        organizationId,
        agentId: dto.agentId,
        content: base64Content,
        isPdf: true,
      } as KnowledgeIndexerJobData,
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
      },
    );

    this.logger.log(
      `knowledge_created sourceId=${source.id} type=PDF fileName=${file.originalname} organizationId=${organizationId}`,
    );

    return source;
  }

  /**
   * List knowledge sources for an organization or specific agent.
   */
  async listKnowledge(organizationId: string, agentId?: string) {
    return this.repository.listByOrganization(organizationId, agentId);
  }

  /**
   * Get a single knowledge source by ID.
   */
  async getKnowledgeById(id: string) {
    const source = await this.repository.findById(id);
    if (!source) {
      throw new NotFoundException('Knowledge source not found');
    }
    return source;
  }

  /**
   * Delete a knowledge source and its vector chunks.
   */
  async deleteKnowledge(id: string) {
    const source = await this.repository.findById(id);
    if (!source) {
      throw new NotFoundException('Knowledge source not found');
    }

    // Delete all vector entries for this source
    // chunks are named: knowledge:${sourceId}:${index}
    // For now, we'll rely on the caller to use the RAG deletion API
    // or implement a bulk delete in VectorStoreService

    await this.repository.delete(id);

    this.logger.log(`knowledge_deleted sourceId=${id}`);

    return source;
  }

  /**
   * Reindex a knowledge source (mark as PENDING and enqueue).
   */
  async reindexKnowledge(id: string) {
    const source = await this.repository.findById(id);
    if (!source) {
      throw new NotFoundException('Knowledge source not found');
    }

    // Reset status to PENDING
    await this.repository.updateStatus(id, 'PENDING');

    // Requeue for indexing
    await this.knowledgeQueue.add(
      'index_knowledge',
      {
        type: 'index_knowledge',
        sourceId: source.id,
        organizationId: source.organizationId,
        agentId: source.agentId,
        content: source.content,
        isPdf: source.sourceType === 'PDF',
      } as KnowledgeIndexerJobData,
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
      },
    );

    this.logger.log(`knowledge_reindex_queued sourceId=${id}`);

    return source;
  }
}
