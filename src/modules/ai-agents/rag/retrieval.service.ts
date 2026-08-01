import { Injectable, Logger } from '@nestjs/common';
import { EmbeddingsService } from './embeddings.service';
import { RerankerService } from './reranker.service';
import { VectorStoreService } from './vector-store.service';
import { DEFAULT_RAG_CONFIG, type SearchQuery, type SearchResult, type SearchScope } from './types';

/**
 * High-level RAG entry point — what the prompt composer (Layer 4 CONTEXT)
 * calls to fetch relevant snippets for the current turn.
 *
 * Pipeline:
 *   1. Embed the query string (1 OpenAI call).
 *   2. Run cosine similarity search in the vector store, scoped by
 *      agent / contact / conversation / owner type.
 *   3. Optionally rerank with the cheap Fugu model (off by default — keep it cheap).
 */
@Injectable()
export class RetrievalService {
  private readonly logger = new Logger(RetrievalService.name);

  constructor(
    private readonly embeddings: EmbeddingsService,
    private readonly store: VectorStoreService,
    private readonly reranker: RerankerService,
  ) {}

  async retrieve(
    input: SearchQuery & { rerank?: boolean },
  ): Promise<SearchResult[]> {
    const t0 = Date.now();
    const k = input.k ?? DEFAULT_RAG_CONFIG.k;
    const minScore = input.minScore ?? DEFAULT_RAG_CONFIG.minScore;

    const emb = await this.embeddings.embed(input.query);
    let results = await this.store.search(emb.vector, input.scope, k, minScore);

    const shouldRerank = input.rerank ?? DEFAULT_RAG_CONFIG.rerankEnabled;
    if (shouldRerank && results.length > 1) {
      results = await this.reranker.rerank(input.query, results);
    }

    this.logger.log(
      `retrieve k=${k} minScore=${minScore} hits=${results.length} rerank=${shouldRerank} durationMs=${Date.now() - t0}`,
    );

    return results;
  }

  /**
   * Retrieve from multiple scopes with a single embedding call.
   *
   * Useful for searching both conversation history and knowledge base
   * without doubling the embedding cost.
   *
   * @param query Search query text
   * @param scopes Array of SearchScope objects to search
   * @param k Results per scope
   * @param minScore Minimum similarity threshold
   * @returns Object mapping scope to results array
   *
   * Example:
   *   const results = await retrieval.retrieveMulti(
   *     "política de garantia",
   *     [
   *       { organizationId, agentId, ownerType: 'any' },
   *       { organizationId, ownerType: 'knowledge', agentScope: { agentId, includeOrgWide: true } }
   *     ]
   *   );
   *   results[0] // history results
   *   results[1] // knowledge results
   */
  async retrieveMulti(
    query: string,
    scopes: SearchScope[],
    k = 5,
    minScore = 0.7,
  ): Promise<SearchResult[][]> {
    const t0 = Date.now();

    // Single embedding call
    const emb = await this.embeddings.embed(query);

    // Parallel searches across all scopes
    const resultArrays = await Promise.all(
      scopes.map((scope) =>
        this.store.search(emb.vector, scope, k, minScore),
      ),
    );

    this.logger.log(
      `retrieve_multi scopes=${scopes.length} k=${k} minScore=${minScore} ` +
        `hits=[${resultArrays.map((r) => r.length).join(',')}] durationMs=${Date.now() - t0}`,
    );

    return resultArrays;
  }
}
