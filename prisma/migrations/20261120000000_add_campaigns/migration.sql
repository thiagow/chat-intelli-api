-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'VALIDATING', 'READY', 'SUBMITTING', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "CampaignReplyRouting" AS ENUM ('CHANNEL_DEFAULT', 'AI', 'HUMAN');

-- CreateEnum
CREATE TYPE "CampaignConsentSource" AS ENUM ('CLIENTES_ATIVOS', 'LEADS_INBOUND', 'PARCEIROS', 'OUTRO');

-- CreateEnum
CREATE TYPE "CampaignBatchStatus" AS ENUM ('PLANNED', 'SUBMITTING', 'SCHEDULED', 'RUNNING', 'DONE', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "CampaignRecipientStatus" AS ENUM ('PENDING', 'INVALID', 'DUPLICATE', 'OPTED_OUT', 'NOT_ON_WHATSAPP', 'VALID', 'QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "marketing_opt_out_at" TIMESTAMP(3),
ADD COLUMN     "marketing_opt_out_source" TEXT;

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "created_by_id" TEXT,
    "name" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "delay_min_sec" INTEGER NOT NULL DEFAULT 30,
    "delay_max_sec" INTEGER NOT NULL DEFAULT 90,
    "scheduled_at" TIMESTAMP(3),
    "reply_routing" "CampaignReplyRouting" NOT NULL DEFAULT 'CHANNEL_DEFAULT',
    "reply_window_days" INTEGER NOT NULL DEFAULT 7,
    "daily_cap" INTEGER NOT NULL DEFAULT 200,
    "send_window_start" TEXT NOT NULL DEFAULT '09:00',
    "send_window_end" TEXT NOT NULL DEFAULT '18:00',
    "send_weekdays" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5]::INTEGER[],
    "max_failure_rate_pct" INTEGER NOT NULL DEFAULT 15,
    "append_opt_out_footer" BOOLEAN NOT NULL DEFAULT true,
    "consent_source" "CampaignConsentSource" NOT NULL,
    "consent_note" TEXT,
    "auto_paused_reason" TEXT,
    "source_file_name" TEXT,
    "stats" JSONB NOT NULL DEFAULT '{}',
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_batches" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "batch_index" INTEGER NOT NULL,
    "scheduled_for" TIMESTAMP(3) NOT NULL,
    "status" "CampaignBatchStatus" NOT NULL DEFAULT 'PLANNED',
    "provider_folder_id" TEXT,
    "recipient_count" INTEGER NOT NULL DEFAULT 0,
    "submitted_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_recipients" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "row_number" INTEGER NOT NULL,
    "raw_phone" TEXT NOT NULL,
    "phone_e164" TEXT,
    "jid" TEXT,
    "company_name" TEXT NOT NULL,
    "message_text" TEXT NOT NULL,
    "rendered_text" TEXT,
    "status" "CampaignRecipientStatus" NOT NULL DEFAULT 'PENDING',
    "invalid_reason" TEXT,
    "batch_id" TEXT,
    "contact_id" TEXT,
    "conversation_id" TEXT,
    "message_id" TEXT,
    "provider_message_id" TEXT,
    "error" TEXT,
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "read_at" TIMESTAMP(3),
    "replied_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_campaign_org_status" ON "campaigns"("organization_id", "status");

-- CreateIndex
CREATE INDEX "idx_campaign_channel_status" ON "campaigns"("channel_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_batches_provider_folder_id_key" ON "campaign_batches"("provider_folder_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_batches_campaign_id_batch_index_key" ON "campaign_batches"("campaign_id", "batch_index");

-- CreateIndex
CREATE INDEX "idx_campaign_recipient_status" ON "campaign_recipients"("campaign_id", "status");

-- CreateIndex
CREATE INDEX "idx_campaign_recipient_provider_msg" ON "campaign_recipients"("provider_message_id");

-- CreateIndex
CREATE INDEX "idx_campaign_recipient_contact" ON "campaign_recipients"("contact_id", "status");

-- CreateIndex
CREATE INDEX "idx_campaign_recipient_batch" ON "campaign_recipients"("batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_recipients_campaign_id_phone_e164_key" ON "campaign_recipients"("campaign_id", "phone_e164");

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_batches" ADD CONSTRAINT "campaign_batches_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "campaign_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Uma campanha ativa por canal: a fila da UaZAPI é por instância, duas campanhas
-- simultâneas somariam ritmo e risco de ban. Lock em aplicação não garante isso.
CREATE UNIQUE INDEX "uq_campaign_active_per_channel" ON "campaigns"("channel_id")
  WHERE "status" IN ('SUBMITTING', 'SCHEDULED', 'RUNNING', 'PAUSED') AND "deleted_at" IS NULL;
