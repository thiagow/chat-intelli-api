import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { KnowledgeStatus, SourceType } from '@prisma/client';

@Injectable()
export class KnowledgeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: {
    organizationId: string;
    agentId?: string | null;
    title: string;
    sourceType: SourceType;
    content: string;
    fileUrl?: string;
    fileName?: string;
    fileSize?: number;
  }) {
    return this.prisma.knowledgeSource.create({
      data: {
        organizationId: data.organizationId,
        agentId: data.agentId,
        title: data.title,
        sourceType: data.sourceType,
        content: data.content,
        fileUrl: data.fileUrl,
        fileName: data.fileName,
        fileSize: data.fileSize,
        status: 'PENDING',
      },
    });
  }

  async findById(id: string) {
    return this.prisma.knowledgeSource.findUnique({ where: { id } });
  }

  async listByOrganization(organizationId: string, agentId?: string) {
    return this.prisma.knowledgeSource.findMany({
      where: {
        organizationId,
        // Se agentId não for fornecido, retorna org-wide (onde agentId é null)
        // Se agentId for fornecido, retorna documentos daquele agente
        agentId: agentId ?? null,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateStatus(id: string, status: KnowledgeStatus, errorMessage?: string, chunkCount?: number) {
    return this.prisma.knowledgeSource.update({
      where: { id },
      data: {
        status,
        errorMessage: errorMessage ?? null,
        chunkCount: chunkCount ?? null,
      },
    });
  }

  async delete(id: string) {
    return this.prisma.knowledgeSource.delete({ where: { id } });
  }
}
