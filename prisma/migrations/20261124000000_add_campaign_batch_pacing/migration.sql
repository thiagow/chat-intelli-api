-- AlterTable: ritmo entre lotes (tamanho máximo do lote + pausa aleatória entre lotes)
ALTER TABLE "campaigns" ADD COLUMN     "batch_size" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "batch_pause_min_sec" INTEGER NOT NULL DEFAULT 300,
ADD COLUMN     "batch_pause_max_sec" INTEGER NOT NULL DEFAULT 900;
