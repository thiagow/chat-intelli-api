import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { StorageProvider } from './storage.provider';

/**
 * Cloudflare R2 storage (S3-compatible API). Used instead of local disk in
 * production so uploaded files survive redeploys and work across multiple
 * instances. Activated automatically when R2_* env vars are present — see
 * storage.module.ts.
 */
@Injectable()
export class R2StorageProvider implements StorageProvider {
  private readonly logger = new Logger(R2StorageProvider.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicUrlBase: string;

  constructor(config: ConfigService) {
    const accountId = config.get<string>('R2_ACCOUNT_ID');
    this.bucket = config.get<string>('R2_BUCKET') || '';
    this.publicUrlBase = (config.get<string>('R2_PUBLIC_URL') || '').replace(/\/$/, '');

    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.get<string>('R2_ACCESS_KEY_ID') || '',
        secretAccessKey: config.get<string>('R2_SECRET_ACCESS_KEY') || '',
      },
    });
  }

  async write(key: string, buffer: Buffer, mimeType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
      }),
    );
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async lastModified(key: string): Promise<Date | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return res.LastModified ?? null;
    } catch (err) {
      this.logger.warn(`lastModified failed for ${key}: ${(err as Error).message}`);
      return null;
    }
  }

  publicUrl(key: string): string {
    return `${this.publicUrlBase}/${key}`;
  }

  keyFromUrl(url: string): string | null {
    if (!this.publicUrlBase || !url.startsWith(`${this.publicUrlBase}/`)) return null;
    return url.slice(this.publicUrlBase.length + 1).split(/[?#]/)[0];
  }
}
