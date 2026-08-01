import { IsString, IsOptional, MinLength, MaxLength, IsUUID } from 'class-validator';

/**
 * DTO para fazer upload de PDF como fonte de conhecimento.
 *
 * Usada em POST /knowledge/upload com multipart/form-data:
 * - file: PDF binary
 * - title: string (metadado)
 * - agentId?: string (opcional)
 */
export class UploadKnowledgeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title: string;

  @IsOptional()
  @IsUUID()
  agentId?: string;
}
