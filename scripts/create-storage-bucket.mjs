#!/usr/bin/env node
/**
 * Create a PUBLIC Supabase Storage bucket for media blobs. A public bucket yields
 * browser-GET-able URLs (via getPublicUrl) so <img>/<video> can render the stored
 * ossKey directly. Idempotent: ignores "already exists". Run once after starting
 * the self-hosted Supabase stack:
 *
 *   node scripts/create-storage-bucket.mjs
 *   SUPABASE_STORAGE_BUCKET=avatars node scripts/create-storage-bucket.mjs
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the env (e.g.
 * `set -a; . .env.local; set +a`). Prints the bucket name on success.
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'media';

if (!url || !serviceRoleKey) {
  console.error(
    'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Source .env.local first.',
  );
  process.exit(1);
}

const supabase = createClient(url, serviceRoleKey);

const { error } = await supabase.storage.createBucket(bucket, { public: true });
if (error && !/already exists/i.test(error.message)) {
  console.error(`Failed to create bucket "${bucket}":`, error.message);
  process.exit(1);
}

console.log(bucket);
