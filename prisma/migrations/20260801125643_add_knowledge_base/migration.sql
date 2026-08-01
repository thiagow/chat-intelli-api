-- Fundação da base de conhecimento com RAG
-- 1. Extensão pgvector para buscas vetoriais
-- 2. Tabela de entradas vetoriais (embeddings)
-- 3. Tabela de fontes de conhecimento (documentos)
-- 4. Campos de empresa na organização

-- 1. Criar extensão pgvector (defensivo: IF NOT EXISTS)
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Criar tabela ai_vector_entries se não existir
-- Armazena embeddings de chunks de conhecimento e histórico de conversa
CREATE TABLE IF NOT EXISTS "ai_vector_entries" (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding VECTOR(1536) NOT NULL,
  metadata JSON,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "fk_ai_vector_entries_organization"
    FOREIGN KEY (organization_id) REFERENCES "organizations"(id) ON DELETE CASCADE
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS "idx_ai_vector_entries_owner" ON "ai_vector_entries"("owner_type", "owner_id");
CREATE INDEX IF NOT EXISTS "idx_ai_vector_entries_organization" ON "ai_vector_entries"("organization_id");
CREATE INDEX IF NOT EXISTS "idx_ai_vector_entries_embedding" ON "ai_vector_entries" USING HNSW (embedding vector_cosine_ops);

-- 3. Criar tabela knowledge_sources (fontes de conhecimento)
-- Armazena metadata de documentos (fontes) que geram chunks no vector store
CREATE TABLE IF NOT EXISTS "knowledge_sources" (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  agent_id TEXT,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('TEXT', 'PDF')),
  content TEXT NOT NULL,
  file_url TEXT,
  file_name TEXT,
  file_size INTEGER,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'READY', 'FAILED')),
  error_message TEXT,
  chunk_count INTEGER,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "fk_knowledge_sources_organization"
    FOREIGN KEY (organization_id) REFERENCES "organizations"(id) ON DELETE CASCADE,
  CONSTRAINT "fk_knowledge_sources_agent"
    FOREIGN KEY (agent_id) REFERENCES "ai_agents"(id) ON DELETE CASCADE
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS "idx_knowledge_sources_organization" ON "knowledge_sources"("organization_id");
CREATE INDEX IF NOT EXISTS "idx_knowledge_sources_agent" ON "knowledge_sources"("agent_id");
CREATE INDEX IF NOT EXISTS "idx_knowledge_sources_status" ON "knowledge_sources"("status");
CREATE INDEX IF NOT EXISTS "idx_knowledge_sources_org_agent" ON "knowledge_sources"("organization_id", "agent_id");

-- 4. Adicionar campos de empresa à tabela organizations
-- Dados cadastrais (não vão ao prompt do agente por design)
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "legal_name" TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "trade_name" TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "document" TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "email" TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "website" TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "address_zip" TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "address_street" TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "address_number" TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "address_complement" TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "address_district" TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "address_city" TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "address_state" TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "address_country" TEXT;

-- Índice opcional para busca por CNPJ
CREATE INDEX IF NOT EXISTS "idx_organizations_document" ON "organizations"("document");
