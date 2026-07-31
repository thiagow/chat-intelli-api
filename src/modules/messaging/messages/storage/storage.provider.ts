export const STORAGE_PROVIDER = 'STORAGE_PROVIDER';

/**
 * Abstraction over "where uploaded files physically live". `key` is always
 * a relative path (e.g. `media/2026-07-31/abc123.jpg`) — providers decide
 * how to turn that into a real location (disk path, S3 object key, ...).
 */
export interface StorageProvider {
  write(key: string, buffer: Buffer, mimeType: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  lastModified(key: string): Promise<Date | null>;
  publicUrl(key: string): string;
  /** Inverse of publicUrl: null when the URL isn't one of ours. */
  keyFromUrl(url: string): string | null;
}
