import { NoopStorageProvider } from './providers/noop';
import { S3StorageProvider } from './providers/s3';
import type { StorageProvider } from './types';

let _provider: StorageProvider | null = null;

/**
 * Selects the storage backend by env. Configure S3_* (see .env.example) to
 * offload media blobs to S3/R2/MinIO; otherwise falls back to the no-op
 * provider (blobs stay client-side in IndexedDB, the local-first default).
 */
export function getStorageProvider(): StorageProvider {
  if (_provider) return _provider;

  const bucket = process.env.S3_BUCKET;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;

  if (bucket && accessKeyId && secretAccessKey) {
    _provider = new S3StorageProvider({
      bucket,
      region: process.env.S3_REGION || 'us-east-1',
      endpoint: process.env.S3_ENDPOINT,
      accessKeyId,
      secretAccessKey,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
      publicBaseUrl: process.env.S3_PUBLIC_BASE_URL,
    });
  } else {
    _provider = new NoopStorageProvider();
  }
  return _provider;
}

export type { StorageProvider, StorageType } from './types';
