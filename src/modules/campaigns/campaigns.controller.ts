import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { CurrentChannelAccess, CurrentOrg, CurrentUser, Roles } from '../../common/decorators';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import type { ChannelAccess } from '../iam/channel-access/channel-access.service';
import { CAMPAIGN_LIMITS } from './campaigns.constants';
import { CampaignsService } from './campaigns.service';
import {
  ImportCampaignDto,
  ListCampaignsQueryDto,
  ListRecipientsQueryDto,
  PreviewCampaignQueryDto,
  UpdateCampaignDto,
} from './dto/campaign.dto';

@ApiTags('Campaigns')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('campaigns')
export class CampaignsController {
  constructor(private readonly service: CampaignsService) {}

  @Get('capabilities')
  @ApiOperation({ summary: 'Canais aptos a envio em massa + limites' })
  capabilities(@CurrentOrg('id') orgId: string, @CurrentChannelAccess() access: ChannelAccess) {
    return this.service.capabilities(orgId, access);
  }

  @Get()
  @ApiOperation({ summary: 'Listar campanhas' })
  list(
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
    @Query() query: ListCampaignsQueryDto,
  ) {
    return this.service.list(orgId, access, query);
  }

  @Post('import')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Importar CSV (whatsapp, empresa, mensagem) e criar a campanha em rascunho' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: CAMPAIGN_LIMITS.maxFileBytes, files: 1 },
    }),
  )
  import(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @CurrentChannelAccess() access: ChannelAccess,
    @Body() dto: ImportCampaignDto,
    @UploadedFile() file: { buffer: Buffer; originalname?: string } | undefined,
  ) {
    return this.service.import(orgId, userId, access, dto, file);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalhe da campanha (stats, lotes, estimativa)' })
  get(@Param('id') id: string, @CurrentOrg('id') orgId: string, @CurrentChannelAccess() access: ChannelAccess) {
    return this.service.get(orgId, id, access);
  }

  @Get(':id/recipients')
  @ApiOperation({ summary: 'Destinatários (paginado, filtrável)' })
  recipients(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
    @Query() query: ListRecipientsQueryDto,
  ) {
    return this.service.recipients(orgId, id, access, query);
  }

  @Get(':id/preview')
  @ApiOperation({ summary: 'Pré-visualiza a mensagem renderizada (variáveis + spintax) com um destinatário real' })
  preview(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
    @Query() query: PreviewCampaignQueryDto,
  ) {
    return this.service.preview(orgId, id, access, query);
  }

  @Patch(':id')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Configurar campanha (antes de iniciar)' })
  update(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentChannelAccess() access: ChannelAccess,
    @Body() dto: UpdateCampaignDto,
  ) {
    return this.service.update(orgId, id, access, dto);
  }

  @Post(':id/start')
  @HttpCode(200)
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Iniciar: planeja lotes diários e submete à fila do provider' })
  start(@Param('id') id: string, @CurrentOrg('id') orgId: string, @CurrentChannelAccess() access: ChannelAccess) {
    return this.service.start(orgId, id, access);
  }

  @Post(':id/webhook-secret')
  @HttpCode(200)
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Gera novo segredo de assinatura do webhook de resposta (valor devolvido uma única vez)' })
  rotateWebhookSecret(@Param('id') id: string, @CurrentOrg('id') orgId: string, @CurrentChannelAccess() access: ChannelAccess) {
    return this.service.rotateWebhookSecret(orgId, id, access);
  }

  @Post(':id/webhook-test')
  @HttpCode(200)
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Envia um evento de teste assinado para a URL do webhook de resposta' })
  testWebhook(@Param('id') id: string, @CurrentOrg('id') orgId: string, @CurrentChannelAccess() access: ChannelAccess) {
    return this.service.testWebhook(orgId, id, access);
  }

  @Post(':id/pause')
  @HttpCode(200)
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  pause(@Param('id') id: string, @CurrentOrg('id') orgId: string, @CurrentChannelAccess() access: ChannelAccess) {
    return this.service.pause(orgId, id, access);
  }

  @Post(':id/resume')
  @HttpCode(200)
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  resume(@Param('id') id: string, @CurrentOrg('id') orgId: string, @CurrentChannelAccess() access: ChannelAccess) {
    return this.service.resume(orgId, id, access);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  cancel(@Param('id') id: string, @CurrentOrg('id') orgId: string, @CurrentChannelAccess() access: ChannelAccess) {
    return this.service.cancel(orgId, id, access);
  }

  @Post(':id/send-now')
  @HttpCode(200)
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Antecipar lote já agendado no provider' })
  sendNow(@Param('id') id: string, @CurrentOrg('id') orgId: string, @CurrentChannelAccess() access: ChannelAccess) {
    return this.service.sendNow(orgId, id, access);
  }
}
