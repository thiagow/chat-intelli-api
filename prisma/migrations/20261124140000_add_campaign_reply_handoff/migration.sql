-- AlterTable: handoff na resposta (webhook assinado + contexto para a IA)
ALTER TABLE "campaigns" ADD COLUMN     "on_reply_webhook_url" TEXT,
ADD COLUMN     "on_reply_webhook_secret" TEXT,
ADD COLUMN     "reply_ai_context" TEXT;

-- AlterTable: estado da entrega do webhook por destinatário
ALTER TABLE "campaign_recipients" ADD COLUMN     "reply_webhook_status" TEXT,
ADD COLUMN     "reply_webhook_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reply_webhook_error" TEXT,
ADD COLUMN     "reply_webhook_at" TIMESTAMP(3);
