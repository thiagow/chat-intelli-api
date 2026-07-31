import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { StorageProvider } from './storage.provider';

/** Default storage: writes under UPLOADS_DIR, served via express.static in main.ts. */
@Injectable()
export class LocalStorageProvider implements StorageProvider {
  private readonly rootDir: string;
  private readonly appUrl: string;
  private readonly publicBaseUrl: string;

  constructor(config: ConfigService) {
    this.rootDir = path.resolve(
      config.get<string>('UPLOADS_DIR') || path.join(process.cwd(), 'uploads'),
    );
    this.appUrl = (config.get<string>('APP_URL') || '').replace(/\/$/, '');
    this.publicBaseUrl = `${this.appUrl}/api/v1/uploads`;
    if (!fs.existsSync(this.rootDir)) fs.mkdirSync(this.rootDir, { recursive: true });
  }

  async write(key: string, buffer: Buffer): Promise<void> {
    const full = path.join(this.rootDir, key);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, buffer);
  }

  async exists(key: string): Promise<boolean> {
    return fs.existsSync(path.join(this.rootDir, key));
  }

  async lastModified(key: string): Promise<Date | null> {
    try {
      return fs.statSync(path.join(this.rootDir, key)).mtime;
    } catch {
      return null;
    }
  }

  publicUrl(key: string): string {
    return `${this.publicBaseUrl}/${key}`;
  }

  keyFromUrl(url: string): string | null {
    const marker = '/api/v1/uploads/';
    const idx = url.indexOf(marker);
    if (idx === -1) return null;

    if (this.appUrl && !url.startsWith(`${this.appUrl}${marker}`)) return null;

    let relative = url.slice(idx + marker.length).split(/[?#]/)[0];
    try {
      relative = decodeURIComponent(relative);
    } catch {
      // keep raw — worst case exists() returns false and caller re-resolves
    }
    const full = path.resolve(this.rootDir, relative);
    if (full !== this.rootDir && !full.startsWith(this.rootDir + path.sep)) return null;
    return relative;
  }
}
