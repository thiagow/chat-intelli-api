import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CampaignConsentSource, CampaignReplyRouting, CampaignRecipientStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { CAMPAIGN_LIMITS } from '../campaigns.constants';

const HM = /^([01]?\d|2[0-3]):[0-5]\d$/;

/** Campos de texto do multipart `POST /campaigns/import` (o arquivo vem à parte). */
export class ImportCampaignDto {
  @ApiProperty()
  @IsString()
  channelId!: string;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ enum: CampaignConsentSource })
  @IsEnum(CampaignConsentSource)
  consentSource!: CampaignConsentSource;

  @ApiPropertyOptional({ description: 'Obrigatório quando consentSource = OUTRO' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  consentNote?: string;
}

export class UpdateCampaignDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ description: 'Segundos' })
  @IsOptional()
  @IsInt()
  @Min(CAMPAIGN_LIMITS.minDelaySec)
  @Max(CAMPAIGN_LIMITS.maxDelaySec)
  delayMinSec?: number;

  @ApiPropertyOptional({ description: 'Segundos' })
  @IsOptional()
  @IsInt()
  @Min(CAMPAIGN_LIMITS.minDelaySec)
  @Max(CAMPAIGN_LIMITS.maxDelaySec)
  delayMaxSec?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  scheduledAt?: string | null;

  @ApiPropertyOptional({ enum: CampaignReplyRouting })
  @IsOptional()
  @IsEnum(CampaignReplyRouting)
  replyRouting?: CampaignReplyRouting;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  replyWindowDays?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(CAMPAIGN_LIMITS.maxDailyCap)
  dailyCap?: number;

  @ApiPropertyOptional({ description: 'Máximo de mensagens por lote (cada lote é uma pasta na UaZAPI)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(CAMPAIGN_LIMITS.maxBatchSize)
  batchSize?: number;

  @ApiPropertyOptional({ description: 'Tamanho mínimo do lote (o tamanho de cada lote é sorteado entre este valor e batchSize)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(CAMPAIGN_LIMITS.maxBatchSize)
  batchSizeMin?: number;

  @ApiPropertyOptional({ description: 'Variação máxima, em minutos, no início do dia de envio' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(CAMPAIGN_LIMITS.maxStartJitterMin)
  startJitterMaxMin?: number;

  @ApiPropertyOptional({ description: 'Digitação simulada mínima por mensagem (ms)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(CAMPAIGN_LIMITS.maxTypingMs)
  typingMinMs?: number;

  @ApiPropertyOptional({ description: 'Digitação simulada máxima por mensagem (ms). 0 = desligada' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(CAMPAIGN_LIMITS.maxTypingMs)
  typingMaxMs?: number;

  @ApiPropertyOptional({ description: 'Pausa mínima entre lotes, em segundos' })
  @IsOptional()
  @IsInt()
  @Min(CAMPAIGN_LIMITS.minBatchPauseSec)
  @Max(CAMPAIGN_LIMITS.maxBatchPauseSec)
  batchPauseMinSec?: number;

  @ApiPropertyOptional({ description: 'Pausa máxima entre lotes, em segundos' })
  @IsOptional()
  @IsInt()
  @Min(CAMPAIGN_LIMITS.minBatchPauseSec)
  @Max(CAMPAIGN_LIMITS.maxBatchPauseSec)
  batchPauseMaxSec?: number;

  @ApiPropertyOptional({ description: 'URL https chamada (POST assinado) quando o contato responde. Vazio/null remove.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  onReplyWebhookUrl?: string | null;

  @ApiPropertyOptional({ description: 'Contexto da campanha injetado na IA que assume a conversa após a resposta' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  replyAiContext?: string | null;

  @ApiPropertyOptional({ example: '09:00' })
  @IsOptional()
  @Matches(HM)
  sendWindowStart?: string;

  @ApiPropertyOptional({ example: '18:00' })
  @IsOptional()
  @Matches(HM)
  sendWindowEnd?: string;

  @ApiPropertyOptional({ description: '0=domingo … 6=sábado' })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  sendWeekdays?: number[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  maxFailureRatePct?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  appendOptOutFooter?: boolean;
}

export class ListCampaignsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class ListRecipientsQueryDto extends ListCampaignsQueryDto {
  @ApiPropertyOptional({ enum: CampaignRecipientStatus })
  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsEnum(CampaignRecipientStatus)
  status?: CampaignRecipientStatus;

  @ApiPropertyOptional({ description: 'true = só quem respondeu' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  replied?: boolean;
}

export class PreviewCampaignQueryDto {
  @ApiPropertyOptional({ description: 'Quantas variações renderizar (1–5)', default: 3 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  n?: number;

  @ApiPropertyOptional({ description: 'Anexar o rodapé de opt-out (padrão: o da campanha)' })
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : value === 'true' || value === true))
  @IsBoolean()
  footer?: boolean;
}
