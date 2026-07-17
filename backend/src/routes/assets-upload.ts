/**
 * POST /api/assets/upload — mirrors app/api/assets/upload/route.ts.
 * multipart/form-data; session via getCurrentSession (ALS set by authMiddleware).
 */
import { Hono } from 'hono';
import { createHash } from 'crypto';
import { getStorageProvider } from '@/lib/storage';
import type { StorageType } from '@/lib/storage';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { getCurrentSession } from '@/lib/server/session';
import { authMiddleware, type AuthVars } from '../server/auth';

const ALLOWED_TYPES = new Set<StorageType>(['media', 'poster', 'audio']);

export const assetsUploadRoute = new Hono<AuthVars>();
assetsUploadRoute.use('*', authMiddleware);

assetsUploadRoute.post('/', async (c) => {
  const session = await getCurrentSession();
  if (!session) {
    return apiError('UNAUTHENTICATED', 401, 'Sign in required');
  }

  let form: FormData;
  try {
    form = await c.req.raw.formData();
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
});
