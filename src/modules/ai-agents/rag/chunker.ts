/**
 * Text chunking for RAG indexing.
 *
 * Strategy:
 * 1. Break text into paragraphs (separated by blank lines)
 * 2. Group paragraphs until ~1000 characters
 * 3. Maintain ~100 character overlap between chunks
 * 4. Truncate chunks that exceed token limit (8191 for text-embedding-3-small)
 *
 * Token estimation: conservatively assume 1 token ≈ 4 characters.
 * OpenAI's text-embedding-3-small rejects inputs >8191 tokens.
 */

export interface Chunk {
  text: string;
  index: number;
}

const MAX_TOKENS = 8191;
const CHARS_PER_TOKEN = 4; // Conservative estimate
const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN; // ~32,764 chars

const TARGET_CHUNK_SIZE = 1000;
const OVERLAP_SIZE = 100;

/**
 * Split text into chunks suitable for embedding.
 *
 * @param text Raw text to chunk
 * @returns Array of chunks with text and 0-based index
 * @throws Error if a single paragraph exceeds token limit
 */
export function chunkText(text: string): Chunk[] {
  const chunks: Chunk[] = [];

  // Split by paragraphs (blank lines)
  const paragraphs = text
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (paragraphs.length === 0) {
    return [];
  }

  let currentChunk = '';
  let overlapText = '';

  for (const paragraph of paragraphs) {
    if (paragraph.length > MAX_CHARS) {
      throw new Error(
        `Paragraph exceeds token limit (${Math.ceil(paragraph.length / CHARS_PER_TOKEN)} tokens). ` +
          'Try breaking it into smaller pieces or remove extremely long paragraphs.',
      );
    }

    const potentialChunk = currentChunk
      ? `${currentChunk}\n\n${paragraph}`
      : paragraph;

    // If adding this paragraph would exceed target, flush current chunk
    if (currentChunk && potentialChunk.length > TARGET_CHUNK_SIZE) {
      // Emit the current chunk
      if (currentChunk.length > MAX_CHARS) {
        // Truncate to max allowed
        chunks.push({
          text: currentChunk.slice(0, MAX_CHARS),
          index: chunks.length,
        });
      } else {
        chunks.push({
          text: currentChunk,
          index: chunks.length,
        });
      }

      // Start new chunk with overlap
      overlapText = currentChunk.slice(-OVERLAP_SIZE);
      currentChunk = overlapText ? `${overlapText}\n\n${paragraph}` : paragraph;
    } else {
      currentChunk = potentialChunk;
    }
  }

  // Emit final chunk
  if (currentChunk) {
    if (currentChunk.length > MAX_CHARS) {
      chunks.push({
        text: currentChunk.slice(0, MAX_CHARS),
        index: chunks.length,
      });
    } else {
      chunks.push({
        text: currentChunk,
        index: chunks.length,
      });
    }
  }

  return chunks;
}

/**
 * Estimate token count for text (conservative approximation).
 * Real token count depends on the tokenizer used by the embedding model.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
