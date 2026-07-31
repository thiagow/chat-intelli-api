import { Inject, Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { STORAGE_PROVIDER, StorageProvider } from './storage/storage.provider';

const execFileAsync = promisify(execFile);

export interface UploadResult {
  url: string;
  mimeType: string;
  size: number;
  filename: string;
}

/**
 * Stores user-uploaded media (agent recordings) and inbound media we
 * mirror locally (e.g., WhatsApp Cloud requires a Bearer token to
 * download — browsers can't load it directly, so we re-host it here).
 *
 * Files are written under `uploads/` and served publicly through
 * `/api/v1/uploads/*`. Swap with S3/R2 when we go multi-instance — the
 * public URL contract stays the same.
 */
@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  // 25MB matches OpenAI Whisper's upload cap, so audios we accept are also
  // transcribable without chunking.
  static readonly MAX_AUDIO_BYTES = 25 * 1024 * 1024;

  // 64MB upper bound for any inbound media we mirror. WhatsApp Cloud caps
  // documents at 100MB but most chat content is well under this — bigger
  // files we'd want to stream rather than buffer in memory anyway.
  static readonly MAX_INBOUND_BYTES = 64 * 1024 * 1024;

  private static readonly ALLOWED_AUDIO_MIME = new Set([
    'audio/mpeg',
    'audio/mp4',
    'audio/m4a',
    'audio/ogg',
    'audio/wav',
    'audio/webm',
    'audio/webm;codecs=opus',
  ]);

  // 64MB: acima do cap de vídeo do WhatsApp (16MB) e de imagem (5MB) — o
  // provider rejeita o que não aceitar; aqui só barramos abusos óbvios.
  static readonly MAX_MEDIA_BYTES = 64 * 1024 * 1024;

  private static readonly ALLOWED_MEDIA_MIME = new Set([
    // image
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/heic',
    // video
    'video/mp4',
    'video/quicktime',
    'video/3gpp',
    'video/webm',
    // document
    'application/pdf',
    'application/zip',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'text/csv',
  ]);

  constructor(
    private readonly config: ConfigService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  /**
   * Persists an inbound media buffer (any type — image, video, audio,
   * document, sticker) under a per-channel/per-day folder and returns a
   * playable public URL. Used by adapters whose providers deliver media
   * gated behind auth (WhatsApp Cloud) or via short-lived signed URLs we
   * don't want to depend on.
   *
   * `originalFilename` is preserved when the provider gives one (typical
   * for documents) — useful for the UI to render a familiar filename and
   * for the browser's "Save As" dialog to default sensibly.
   */
  /**
   * Foto de perfil (contato, grupo ou participante). Nome de arquivo
   * determinístico pela `key` (id do contato), por dois motivos: a URL
   * gravada em `contacts.avatar_url` continua válida depois de um redeploy,
   * e o refresh sobrescreve em vez de acumular arquivo órfão.
   *
   * O diretório de uploads não é volume persistente, então o arquivo pode
   * sumir num deploy — quem chama trata isso revalidando (`avatarFileExists`).
   */
  async saveAvatar(input: {
    key: string;
    buffer: Buffer;
    mimeType: string;
  }): Promise<string> {
    if (!input?.buffer?.byteLength) {
      throw new BadRequestException('Empty avatar');
    }
    const mime = (input.mimeType || 'image/jpeg').split(';')[0].trim();
    if (!mime.startsWith('image/')) {
      throw new BadRequestException(`Avatar must be an image, got ${mime}`);
    }

    const safeKey = input.key.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `${safeKey}${this.extFor(mime, null)}`;
    const key = `avatars/${filename}`;
    await this.storage.write(key, input.buffer, mime);
    // O nome do arquivo é estável (um por contato), então sem versão na URL o
    // navegador continuaria mostrando a foto antiga depois de a pessoa trocar
    // a dela. Versionamos pelo CONTEÚDO, não pelo horário: foto igual devolve
    // a mesma URL — e aí a revalidação semanal não vira "mudou a foto" à toa.
    // (`avatarAgeInDays` ignora a query string.)
    const version = crypto
      .createHash('sha1')
      .update(input.buffer)
      .digest('hex')
      .slice(0, 12);
    return `${this.storage.publicUrl(key)}?v=${version}`;
  }

  /**
   * Idade em dias do arquivo por trás de uma URL de avatar, ou `null` se ele
   * não existe (nunca baixado, ou perdido num redeploy). Serve de "quando
   * sincronizamos pela última vez" sem precisar de coluna nova no banco.
   */
  async avatarAgeInDays(avatarUrl: string | null | undefined): Promise<number | null> {
    if (!avatarUrl) return null;
    const key = this.storage.keyFromUrl(avatarUrl.split('?')[0]);
    if (!key || !key.startsWith('avatars/')) return null;
    const lastModified = await this.storage.lastModified(key);
    if (!lastModified) return null;
    return (Date.now() - lastModified.getTime()) / 86_400_000;
  }

  async saveInboundMedia(input: {
    buffer: Buffer;
    mimeType: string;
    channelId: string;
    originalFilename?: string | null;
  }): Promise<UploadResult> {
    if (!input?.buffer?.byteLength) {
      throw new BadRequestException('Empty inbound media');
    }
    if (input.buffer.byteLength > UploadsService.MAX_INBOUND_BYTES) {
      throw new BadRequestException(
        `Inbound media too large (max ${UploadsService.MAX_INBOUND_BYTES / 1024 / 1024}MB)`,
      );
    }

    const mime = (input.mimeType || 'application/octet-stream').split(';')[0].trim();
    const dateFolder = new Date().toISOString().slice(0, 10);
    const safeChannel = (input.channelId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');

    const id = crypto.randomBytes(16).toString('hex');
    const ext = this.extFor(mime, input.originalFilename);
    const filename = `${id}${ext}`;
    const key = `inbound/${safeChannel}/${dateFolder}/${filename}`;
    await this.storage.write(key, input.buffer, mime);

    const url = this.storage.publicUrl(key);
    this.logger.log(`Inbound media saved: ${key} -> ${url}`);
    return {
      url,
      mimeType: mime,
      size: input.buffer.byteLength,
      filename: input.originalFilename || filename,
    };
  }

  /**
   * Upload de mídia do operador (anexo do chat): imagem, vídeo ou documento.
   * Áudio gravado no app continua indo pelo saveAudio (que transcoda pra
   * OGG/Opus voice note); aqui é o caminho do clipe de papel.
   */
  async saveMedia(file: {
    buffer: Buffer;
    mimetype: string;
    originalname?: string;
  }): Promise<UploadResult> {
    if (!file?.buffer?.byteLength) {
      throw new BadRequestException('Empty upload');
    }
    if (file.buffer.byteLength > UploadsService.MAX_MEDIA_BYTES) {
      throw new BadRequestException(
        `File too large (max ${UploadsService.MAX_MEDIA_BYTES / 1024 / 1024}MB)`,
      );
    }
    const mime = (file.mimetype || 'application/octet-stream')
      .split(';')[0]
      .trim();
    if (!UploadsService.ALLOWED_MEDIA_MIME.has(mime)) {
      throw new BadRequestException(`Unsupported file type: ${mime}`);
    }

    const dateFolder = new Date().toISOString().slice(0, 10);
    const id = crypto.randomBytes(16).toString('hex');
    const ext = this.extFor(mime, file.originalname);
    const filename = `${id}${ext}`;
    const key = `media/${dateFolder}/${filename}`;
    await this.storage.write(key, file.buffer, mime);

    const url = this.storage.publicUrl(key);
    this.logger.log(`Media saved: ${key} -> ${url}`);
    return {
      url,
      mimeType: mime,
      size: file.buffer.byteLength,
      filename: file.originalname || filename,
    };
  }

  async saveAudio(file: {
    buffer: Buffer;
    mimetype: string;
    originalname?: string;
  }): Promise<UploadResult> {
    if (!file?.buffer?.byteLength) {
      throw new BadRequestException('Empty upload');
    }
    if (file.buffer.byteLength > UploadsService.MAX_AUDIO_BYTES) {
      throw new BadRequestException(
        `Audio too large (max ${UploadsService.MAX_AUDIO_BYTES / 1024 / 1024}MB)`,
      );
    }
    // Normalise mimetype: browsers sometimes send `audio/webm;codecs=opus`.
    const mime = (file.mimetype || '').split(';')[0].trim() || 'audio/webm';
    if (!UploadsService.ALLOWED_AUDIO_MIME.has(file.mimetype) && !UploadsService.ALLOWED_AUDIO_MIME.has(mime)) {
      throw new BadRequestException(`Unsupported audio mime type: ${file.mimetype}`);
    }

    const dateFolder = new Date().toISOString().slice(0, 10);
    // ffmpeg needs a real filesystem path — scratch files live in the OS
    // temp dir regardless of storage backend, and get deleted once the
    // final buffer is handed off to `storage.write`.
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'audio-'));

    const id = crypto.randomBytes(16).toString('hex');
    const srcExt = this.extFor(mime);
    const srcPath = path.join(tmpDir, `${id}${srcExt}`);
    await fs.promises.writeFile(srcPath, file.buffer);

    // WhatsApp voice notes require OGG/Opus. Browsers (esp. Chrome/Firefox)
    // record in WebM/Opus via MediaRecorder — the codec is compatible but
    // the container is not, so Zappfy rejects the send (HTTP 500). We also
    // rely on the re-encode to write proper duration headers (MediaRecorder
    // streams webm without duration, so the <audio> element shows 0:00).
    let finalPath = srcPath;
    let finalMime = mime;
    try {
      if (mime !== 'audio/ogg') {
        const oggPath = path.join(tmpDir, `${id}.ogg`);
        try {
          await execFileAsync(
            'ffmpeg',
            [
              '-hide_banner',
              '-loglevel', 'error',
              '-y',
              '-i', srcPath,
              '-vn',
              '-c:a', 'libopus',
              '-b:a', '32k',
              '-ac', '1',
              '-ar', '48000',
              '-application', 'voip',
              oggPath,
            ],
            { timeout: 30_000 },
          );
          finalPath = oggPath;
          finalMime = 'audio/ogg';
        } catch (err: any) {
          this.logger.error(`ffmpeg transcode failed: ${err.message}`);
          throw new BadRequestException('Failed to process audio');
        }
      }

      const finalBuffer = await fs.promises.readFile(finalPath);
      const finalName = path.basename(finalPath);
      const key = `audio/${dateFolder}/${finalName}`;
      await this.storage.write(key, finalBuffer, finalMime);

      const url = this.storage.publicUrl(key);
      this.logger.log(`Audio saved: ${key} -> ${url}`);
      return { url, mimeType: finalMime, size: finalBuffer.byteLength, filename: finalName };
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private extFor(mime: string, originalFilename?: string | null): string {
    // Prefer the extension from the provider-given filename when present —
    // it survives mime-sniffing oddities (e.g., Meta sometimes returns
    // application/octet-stream for known doc types).
    if (originalFilename) {
      const ext = path.extname(originalFilename).toLowerCase();
      if (ext && /^\.[a-z0-9]{1,8}$/i.test(ext)) return ext;
    }
    const m = (mime || '').toLowerCase();
    // audio
    if (m.includes('ogg')) return '.ogg';
    if (m.includes('mpeg') && m.startsWith('audio/')) return '.mp3';
    if (m.includes('m4a') || (m.includes('mp4') && m.startsWith('audio/'))) return '.m4a';
    if (m.includes('wav')) return '.wav';
    if (m.includes('webm') && m.startsWith('audio/')) return '.webm';
    // image
    if (m === 'image/jpeg' || m === 'image/jpg') return '.jpg';
    if (m === 'image/png') return '.png';
    if (m === 'image/gif') return '.gif';
    if (m === 'image/webp') return '.webp';
    if (m === 'image/heic') return '.heic';
    // video
    if (m === 'video/mp4') return '.mp4';
    if (m === 'video/quicktime') return '.mov';
    if (m === 'video/3gpp') return '.3gp';
    if (m === 'video/webm') return '.webm';
    // document
    if (m === 'application/pdf') return '.pdf';
    if (m === 'application/zip') return '.zip';
    if (m === 'application/msword') return '.doc';
    if (m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return '.docx';
    if (m === 'application/vnd.ms-excel') return '.xls';
    if (m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return '.xlsx';
    if (m === 'application/vnd.ms-powerpoint') return '.ppt';
    if (m === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return '.pptx';
    if (m === 'text/plain') return '.txt';
    if (m === 'text/csv') return '.csv';
    return '.bin';
  }
}
