import { NoopStorageProvider } from './providers/noop';
import { S3StorageProvider } from './providers/s3';
import { SupabaseStorageProvider } from './providers/supabase';
import type { StorageProvider } from './types';

let _provider: StorageProvider | null = null;

/**
 * Selects the storage backend by env. Prefer Supabase Storage (a PUBLIC bucket
 * gives browser-GET-able URLs for <img>/<video>, which the S3 endpoint is not)
 * when SUPABASE_STORAGE_BUCKET is set; fall back to S3-compatible (R2/MinIO),
 * then to the no-op provider (blobs stay client-side in IndexedDB, the
 * local-first default).
 */
export function getStorageProvider(): StorageProvider {
  if (_provider) return _provider;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseBucket = process.env.SUPABASE_STORAGE_BUCKET;

  if (supabaseUrl && supabaseKey && supabaseBucket) {
    _provider = new SupabaseStorageProvider({
      url: supabaseUrl,
      serviceRoleKey: supabaseKey,
      bucket: supabaseBucket,
    });
    return _provider;
  }

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
