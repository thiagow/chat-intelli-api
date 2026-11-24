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
