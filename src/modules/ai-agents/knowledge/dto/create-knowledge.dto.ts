import { IsString, IsOptional, MinLength, MaxLength, IsUUID } from 'class-validator';

/**
 * DTO para criar uma fonte de conhecimento de texto.
 *
 * Usada em POST /knowledge com payload:
 * {
 *   "title": "Políticas de Garantia",
 *   "content": "...",
 *   "agentId": "uuid" (opcional)
 * }
 */
export class CreateKnowledgeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title: string;

  @IsString()
  @MinLength(1)
  @MaxLength(50000)
  content: string;

  @IsOptional()
  @IsUUID()
  agentId?: string;
}
