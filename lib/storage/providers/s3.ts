import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import type { StorageProvider, StorageType } from '../types';

export interface S3StorageOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  /** Public URL base for objects, e.g. https://cdn.example.com or http://localhost:9000/bucket */
  publicBaseUrl?: string;
}

function keyFor(type: StorageType, hash: string): string {
  return `${type}/${hash}`;
}

/**
 * S3-compatible object storage (AWS S3 / R2 / MinIO). Content-addressed by hash:
 * identical bytes de-duplicate to one object. Objects are private to the bucket;
 * getUrl builds the public URL the app stores as `ossKey`.
 */
export class S3StorageProvider implements StorageProvider {
  private client: S3Client;
  private opts: S3StorageOptions;

  constructor(opts: S3StorageOptions) {
    this.opts = opts;
    this.client = new S3Client({
      region: opts.region,
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      forcePathStyle: opts.forcePathStyle ?? false,
      credentials: {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
      },
    });
  }

  getUrl(hash: string, type: StorageType): string {
    const base =
      this.opts.publicBaseUrl ?? `${this.opts.endpoint}/${this.opts.bucket}`;
    return `${base}/${keyFor(type, hash)}`;
  }

  async exists(hash: string, type: StorageType): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.opts.bucket, Key: keyFor(type, hash) }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async upload(
    hash: string,
    blob: Buffer,
    type: StorageType,
    mimeType?: string,
  ): Promise<string> {
    // Dedup: skip the PUT if the object already exists.
    if (await this.exists(hash, type)) return this.getUrl(hash, type);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: keyFor(type, hash),
        Body: blob,
        ContentType: mimeType ?? 'application/octet-stream',
      }),
    );
    return this.getUrl(hash, type);
  }

  async batchExists(hashes: string[], type: StorageType): Promise<Set<string>> {
    const out = new Set<string>();
    await Promise.all(
      hashes.map(async (h) => {
        if (await this.exists(h, type)) out.add(h);
      }),
    );
    return out;
  }
}
