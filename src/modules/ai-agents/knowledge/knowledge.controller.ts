import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  Query,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiConsumes,
  ApiQuery,
} from '@nestjs/swagger';
import { KnowledgeService } from './knowledge.service';
import { CreateKnowledgeDto } from './dto/create-knowledge.dto';
import { UploadKnowledgeDto } from './dto/upload-knowledge.dto';
import { CurrentOrg } from '../../../common/decorators/current-org.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';

const MAX_PDF_SIZE = 10 * 1024 * 1024; // 10 MB

@Controller('knowledge')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
@ApiTags('Knowledge Base (RAG)')
export class KnowledgeController {
  constructor(private readonly service: KnowledgeService) {}

  /**
   * Create a text-based knowledge source.
   *
   * POST /knowledge
   * {
   *   "title": "Políticas de Garantia",
   *   "content": "...",
   *   "agentId": "uuid" (optional — null for org-wide)
   * }
   */
  @Post()
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({
    summary: 'Create a text-based knowledge source for this organization.',
  })
  async createTextKnowledge(
    @CurrentOrg('id') organizationId: string,
    @Body() dto: CreateKnowledgeDto,
  ) {
    return this.service.createTextKnowledge(organizationId, dto);
  }

  /**
   * Upload a PDF as a knowledge source.
   *
   * POST /knowledge/upload
   * multipart/form-data:
   *   - file: PDF (max 10MB)
   *   - title: string
   *   - agentId?: string (optional)
   */
  @Post('upload')
  @Roles('OWNER', 'ADMIN')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_PDF_SIZE },
    }),
  )
  @ApiOperation({ summary: 'Upload a PDF file as a knowledge source.' })
  @ApiConsumes('multipart/form-data')
  async uploadPdfKnowledge(
    @CurrentOrg('id') organizationId: string,
    @UploadedFile() file: { buffer: Buffer; mimetype: string; originalname?: string } | undefined,
    @Body() dto: UploadKnowledgeDto,
  ) {
    if (!file) {
      throw new BadRequestException('PDF file is required');
    }
    return this.service.uploadPdfKnowledge(organizationId, dto, file);
  }

  /**
   * List knowledge sources.
   *
   * GET /knowledge?agentId=<uuid>  (optional — org-wide if omitted)
   */
  @Get()
  @ApiOperation({
    summary:
      'List knowledge sources for this organization or a specific agent.',
  })
  @ApiQuery({
    name: 'agentId',
    required: false,
    description: 'Filter by agent ID (optional). Omit for org-wide sources.',
  })
  async listKnowledge(
    @CurrentOrg('id') organizationId: string,
    @Query('agentId') agentId?: string,
  ) {
    return this.service.listKnowledge(organizationId, agentId);
  }

  /**
   * Get a single knowledge source by ID.
   *
   * GET /knowledge/:id
   */
  @Get(':id')
  @ApiOperation({
    summary: 'Get a single knowledge source by ID (including indexing status).',
  })
  async getKnowledge(@Param('id') id: string) {
    return this.service.getKnowledgeById(id);
  }

  /**
   * Delete a knowledge source and its vector entries.
   *
   * DELETE /knowledge/:id
   */
  @Delete(':id')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Delete a knowledge source and its vector chunks.' })
  async deleteKnowledge(@Param('id') id: string) {
    return this.service.deleteKnowledge(id);
  }

  /**
   * Reindex a knowledge source (reset status to PENDING and re-enqueue).
   *
   * POST /knowledge/:id/reindex
   */
  @Post(':id/reindex')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Reindex a knowledge source.' })
  async reindexKnowledge(@Param('id') id: string) {
    return this.service.reindexKnowledge(id);
  }
}
