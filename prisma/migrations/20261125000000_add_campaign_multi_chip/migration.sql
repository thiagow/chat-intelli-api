-- CreateTable: chips (canais) do rodízio de uma campanha
CREATE TABLE "campaign_channels" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "daily_limit" INTEGER NOT NULL DEFAULT 200,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_channels_pkey" PRIMARY KEY ("id")
);

-- AlterTable: chip atribuído por lote e por destinatário
ALTER TABLE "campaign_batches" ADD COLUMN     "channel_id" TEXT;
ALTER TABLE "campaign_recipients" ADD COLUMN     "channel_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "campaign_channels_campaign_id_channel_id_key" ON "campaign_channels"("campaign_id", "channel_id");
CREATE INDEX "idx_campaign_channel_channel" ON "campaign_channels"("channel_id");
CREATE INDEX "idx_campaign_batch_chip" ON "campaign_batches"("campaign_id", "channel_id");
CREATE INDEX "idx_campaign_recipient_chip" ON "campaign_recipients"("channel_id");

-- AddForeignKey
ALTER TABLE "campaign_channels" ADD CONSTRAINT "campaign_channels_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "campaign_channels" ADD CONSTRAINT "campaign_channels_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: toda campanha existente vira "rodízio de 1 chip" (o canal primário).
INSERT INTO "campaign_channels" ("id", "campaign_id", "channel_id", "daily_limit", "position")
SELECT 'cc' || substr(md5(random()::text || c."id"), 1, 23), c."id", c."channel_id", c."daily_cap", 0
FROM "campaigns" c;

UPDATE "campaign_recipients" r SET "channel_id" = c."channel_id" FROM "campaigns" c WHERE r."campaign_id" = c."id";
UPDATE "campaign_batches" b SET "channel_id" = c."channel_id" FROM "campaigns" c WHERE b."campaign_id" = c."id";
