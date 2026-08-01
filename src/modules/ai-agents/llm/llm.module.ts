import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LlmService } from './llm.service';
import { AuxModelService } from './aux-model.service';

@Module({
  imports: [ConfigModule],
  providers: [LlmService, AuxModelService],
  exports: [LlmService, AuxModelService],
})
export class LlmModule {}
