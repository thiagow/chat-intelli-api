import {
  IsArray,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateOrganizationDto {
  @ApiPropertyOptional({ example: 'My Company' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  logoUrl?: string;

  // ─── AI settings ────────────────────────────────────────────────

  @ApiPropertyOptional({ description: 'Master kill switch for AI agents' })
  @IsOptional()
  @IsBoolean()
  aiEnabled?: boolean;

  @ApiPropertyOptional({ example: 'America/Sao_Paulo' })
  @IsOptional()
  @IsString()
  aiTimezone?: string;

  @ApiPropertyOptional({
    description:
      'Business hours by weekday. Object with monday..sunday keys, each {enabled, windows: [["09:00","18:00"]]}. Pass null to mean 24/7 (IA responde a qualquer hora).',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsObject()
  aiBusinessHours?: Record<string, unknown> | null;

  @ApiPropertyOptional({
    description:
      'Message sent automatically when an inbound arrives outside business hours. Empty = no auto-reply.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  aiOutOfHoursMessage?: string;

  @ApiPropertyOptional({
    description:
      'When true, AI is auto-paused on a conversation as soon as a human sends a reply.',
  })
  @IsOptional()
  @IsBoolean()
  aiAutoDisableOnHuman?: boolean;

  @ApiPropertyOptional({
    description: 'Monthly LLM token cap across the org. null = unlimited.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  aiMonthlyTokenCap?: number;

  @ApiPropertyOptional({
    description:
      'Notas livres que entram no system prompt de TODOS os agentes da org. Use pra info que muda com frequência (regras de entrega de isca, horários de live, política de reembolso, talking points atuais). Empty = sem notas.',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(4000)
  aiBusinessNotes?: string | null;

  @ApiPropertyOptional({
    description:
      'Lista de domínios permitidos em URLs que a IA pode mandar (ex: ["bravy.co", "trivapp.com.br"]). Quando preenchida, runtime guard bloqueia qualquer link com host fora da lista — IA é forçada a reescrever sem link inventado. Vazia/null = permissivo (só warning). Match é por sufixo: "bravy.co" autoriza "members.bravy.co".',
    nullable: true,
    type: [String],
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsArray()
  @IsString({ each: true })
  allowedUrlDomains?: string[] | null;

  // ─── Watchdog settings ──────────────────────────────────────────

  @ApiPropertyOptional({
    description:
      'Liga/desliga o watchdog de conversas presas. Quando ON, varre conversas onde IA travou ou humano abandonou e reativa atendimento.',
  })
  @IsOptional()
  @IsBoolean()
  watchdogEnabled?: boolean;

  @ApiPropertyOptional({
    description:
      'Horário em que o watchdog atua. Mesmo formato de `aiBusinessHours`. null = roda 24/7.',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsObject()
  watchdogBusinessHours?: Record<string, unknown> | null;

  @ApiPropertyOptional({
    description:
      'Parâmetros do watchdog: `{ delayBotMin, delayPendingMin, delayHumanIdleMin, maxAttempts }`. null = usa defaults (15, 15, 60, 3).',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsObject()
  watchdogConfig?: WatchdogConfigDto | null;

  // ─── Company info (registration-only, not used in agent prompts) ─

  @ApiPropertyOptional({ example: 'Acme Corp LTDA', description: 'Legal company name' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(255)
  legalName?: string | null;

  @ApiPropertyOptional({ example: 'Acme', description: 'Trade/common name' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(255)
  tradeName?: string | null;

  @ApiPropertyOptional({ example: '12.345.678/0001-90', description: 'CNPJ' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(20)
  document?: string | null;

  @ApiPropertyOptional({ description: 'Contact email' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(255)
  email?: string | null;

  @ApiPropertyOptional({ example: '+55 11 99999-9999', description: 'Phone' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(20)
  phone?: string | null;

  @ApiPropertyOptional({ example: 'https://example.com', description: 'Company website' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(255)
  website?: string | null;

  @ApiPropertyOptional({ description: 'Address: zip code' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(20)
  addressZip?: string | null;

  @ApiPropertyOptional({ description: 'Address: street' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(255)
  addressStreet?: string | null;

  @ApiPropertyOptional({ description: 'Address: number' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(20)
  addressNumber?: string | null;

  @ApiPropertyOptional({ description: 'Address: complement' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(255)
  addressComplement?: string | null;

  @ApiPropertyOptional({ description: 'Address: district' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(255)
  addressDistrict?: string | null;

  @ApiPropertyOptional({ description: 'Address: city' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(255)
  addressCity?: string | null;

  @ApiPropertyOptional({ description: 'Address: state' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(2)
  addressState?: string | null;

  @ApiPropertyOptional({ description: 'Address: country' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(255)
  addressCountry?: string | null;
}

export interface WatchdogConfigDto {
  /// Minutos sem resposta com status=BOT antes de reativar IA.
  delayBotMin?: number;
  /// Minutos sem resposta com status=PENDING antes de IA assumir.
  delayPendingMin?: number;
  /// Minutos sem resposta com status=OPEN (humano atribuído) antes de IA reassumir.
  delayHumanIdleMin?: number;
  /// Tentativas antes de marcar como `isStuck` e parar de tentar IA.
  maxAttempts?: number;
}
