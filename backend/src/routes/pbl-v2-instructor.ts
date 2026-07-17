/**
 * POST /api/pbl/v2/instructor — mirrors app/api/pbl/v2/instructor/route.ts.
 * SSE via createSSEResponse; locale sync via applyRequestLocaleToProject(c.req.raw).
 */
import { Hono } from 'hono';
import { createLogger } from '@/lib/logger';
import { apiError } from '@/lib/server/api-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { createSSEResponse } from '@/lib/pbl/v2/api/sse';
import { applyRequestLocaleToProject } from '@/lib/pbl/v2/api/locale';
import { runInstructorTurn, type InstructorPhase } from '@/lib/pbl/v2/agents/instructor';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';
import { requireUserWithQuota, recordGeneration } from '@/lib/server/quota';
import { authMiddleware, type AuthVars } from '../server/auth';
import { withNextUrl } from '../server/request';

const log = createLogger('PBL v2 Instructor API');

interface InstructorRequest {
  project: PBLProjectV2;
  userMessage: string;
  phase?: InstructorPhase;
}

export const pblV2InstructorRoute = new Hono<AuthVars>();
pblV2InstructorRoute.use('*', authMiddleware);

pblV2InstructorRoute.post('/', async (c) => {
  const signal = c.req.raw.signal;
  let body: InstructorRequest;
  try {
    body = (await c.req.json()) as InstructorRequest;
  } catch {
    return apiError('INVALID_REQUEST', 400, 'Request body must be valid JSON.');
  }

  if (!body?.project) {
    return apiError('MISSING_REQUIRED_FIELD', 400, '`project` is required.');
  }
  if (typeof body.userMessage !== 'string' || body.userMessage.trim().length === 0) {
    return apiError('MISSING_REQUIRED_FIELD', 400, '`userMessage` is required.');
  }

  const authed = await requireUserWithQuota();
  if (typeof authed !== 'string') return authed;
  void recordGeneration(authed);

  let resolved;
  try {
    resolved = await resolveModelFromRequest(withNextUrl(c.req.raw, c.req.url), body, 'pbl-v2-runtime:instructor');
  } catch (err) {
    log.error('Model resolution failed:', err);
    return apiError('INVALID_REQUEST', 400, err instanceof Error ? err.message : String(err));
  }

  const { model, thinkingConfig } = resolved;
  const phase = body.phase ?? 'instructing';
  applyRequestLocaleToProject(withNextUrl(c.req.raw, c.req.url), body.project);

  return createSSEResponse(
    runInstructorTurn({ project: body.project, userMessage: body.userMessage, phase, languageModel: model, thinkingConfig, signal }),
    { signal },
  );
});
