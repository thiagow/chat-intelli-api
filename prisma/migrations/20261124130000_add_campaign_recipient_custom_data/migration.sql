-- AlterTable: colunas extras do CSV como variáveis da mensagem
ALTER TABLE "campaign_recipients" ADD COLUMN     "custom_data" JSONB NOT NULL DEFAULT '{}';
