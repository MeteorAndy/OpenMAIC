import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { StorageProvider, StorageType } from '../types';

export interface SupabaseStorageOptions {
  url: string;
  serviceRoleKey: string;
  bucket: string;
}

function keyFor(type: StorageType, hash: string): string {
  return `${type}/${hash}`;
}

/**
 * Supabase Storage provider. Content-addressed by hash (path = `${type}/${hash}`),
 * so identical bytes de-duplicate to one object; upload() uses upsert:true to stay
 * idempotent (re-uploads are a no-op overwrite → same URL). Uses a service-role
 * client — server-side only (the /api/assets/upload route) — which bypasses RLS.
 * getUrl returns the PUBLIC bucket URL, which is browser-GET-able for <img>/<video>
 * (the S3 endpoint URL is not).
 */
export class SupabaseStorageProvider implements StorageProvider {
  private client: SupabaseClient;
  private bucket: string;

  constructor(opts: SupabaseStorageOptions) {
    this.bucket = opts.bucket;
    this.client = createClient(opts.url, opts.serviceRoleKey);
  }

  getUrl(hash: string, type: StorageType): string {
    return this.client.storage
      .from(this.bucket)
      .getPublicUrl(keyFor(type, hash)).data.publicUrl;
  }

  async upload(
    hash: string,
    blob: Buffer,
    type: StorageType,
    mimeType?: string,
  ): Promise<string> {
    // upsert:true IS the dedup: same path overwrites, same bytes → same URL.
    const { error } = await this.client.storage
      .from(this.bucket)
      .upload(keyFor(type, hash), blob, {
        contentType: mimeType ?? 'application/octet-stream',
        upsert: true,
      });
    if (error) throw error;
    return this.getUrl(hash, type);
  }

  async exists(hash: string, type: StorageType): Promise<boolean> {
    const { data } = await this.client.storage
      .from(this.bucket)
      .list(type, { limit: 1000, search: hash });
    return (data ?? []).some((f) => f.name === hash);
  }

  async batchExists(hashes: string[], type: StorageType): Promise<Set<string>> {
    const want = new Set(hashes);
    const out = new Set<string>();
    // ponytail: one folder listing intersected with the wanted set. Misses beyond
    // limit:1000; paginate with offset if a bucket ever holds >1000 of one type.
    const { data } = await this.client.storage.from(this.bucket).list(type, {
      limit: 1000,
    });
    for (const f of data ?? []) {
      if (want.has(f.name)) out.add(f.name);
    }
    return out;
  }
}
