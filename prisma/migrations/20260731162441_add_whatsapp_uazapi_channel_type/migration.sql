-- AlterEnum
ALTER TYPE "ChannelType" ADD VALUE 'WHATSAPP_UAZAPI';

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'AI_TOOL_FAILURE';

-- DropForeignKey
ALTER TABLE "messages" DROP CONSTRAINT "messages_revoked_by_fkey";

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "uq_pipeline_org_key" RENAME TO "pipelines_organization_id_key_key";
