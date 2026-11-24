-- AlterTable: aleatoriedade anti-detecção (tamanho de lote sorteado, jitter de início, digitação simulada)
ALTER TABLE "campaigns" ADD COLUMN     "batch_size_min" INTEGER NOT NULL DEFAULT 12,
ADD COLUMN     "start_jitter_max_min" INTEGER NOT NULL DEFAULT 15,
ADD COLUMN     "typing_min_ms" INTEGER NOT NULL DEFAULT 3000,
ADD COLUMN     "typing_max_ms" INTEGER NOT NULL DEFAULT 6000;
