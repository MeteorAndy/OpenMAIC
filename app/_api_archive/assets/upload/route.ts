import { NextRequest } from 'next/server';
import { createHash } from 'crypto';
import { getStorageProvider } from '@/lib/storage';
import type { StorageType } from '@/lib/storage';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { getCurrentSession } from '@/lib/server/session';

const ALLOWED_TYPES = new Set<StorageType>(['media', 'poster', 'audio']);

/**
 * POST /api/assets/upload (multipart/form-data: file, type)
 * Content-addresses the blob by sha256, uploads it to object storage (dedup),
 * and returns the public URL to store as `ossKey`. Requires a session.
 */
export async function POST(req: NextRequest) {
  const session = await getCurrentSession();
  if (!session) {
    return apiError('UNAUTHENTICATED', 401, 'Sign in required');
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return apiError('INVALID_REQUEST', 400, 'Expected multipart/form-data');
  }

  const file = form.get('file');
  const type = (form.get('type') as string) || 'media';
  if (!(file instanceof Blob)) {
    return apiError('INVALID_REQUEST', 400, 'Missing "file"');
  }
  if (!ALLOWED_TYPES.has(type as StorageType)) {
    return apiError('INVALID_REQUEST', 400, 'Invalid "type"');
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const hash = createHash('sha256').update(buf).digest('hex');
  const url = await getStorageProvider().upload(hash, buf, type as StorageType, file.type);

  return apiSuccess({ url, hash, type });
}
