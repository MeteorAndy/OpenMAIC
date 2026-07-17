/**
 * POST /api/pbl/v2/open-task — mirrors app/api/pbl/v2/open-task/route.ts. SSE.
 */
import { Hono } from 'hono';
import { createLogger } from '@/lib/logger';
import { apiError } from '@/lib/server/api-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { createSSEResponse } from '@/lib/pbl/v2/api/sse';
import { applyRequestLocaleToProject } from '@/lib/pbl/v2/api/locale';
import { runInstructorTurn } from '@/lib/pbl/v2/agents/instructor';
import { applyQuizSignalsToProject } from '@/lib/pbl/v2/operations/quiz-snapshot';
import type { PBLProjectV2, PriorQuizResult } from '@/lib/pbl/v2/types';
import { requireUserWithQuota, recordGeneration } from '@/lib/server/quota';
import { authMiddleware, type AuthVars } from '../server/auth';
import { withNextUrl } from '../server/request';

const log = createLogger('PBL v2 OpenTask API');

interface OpenTaskRequest {
  project: PBLProjectV2;
  phase: 'greeting' | 'setup';
  priorQuizResults?: PriorQuizResult[];
}

export const pblV2OpenTaskRoute = new Hono<AuthVars>();
pblV2OpenTaskRoute.use('*', authMiddleware);

pblV2OpenTaskRoute.post('/', async (c) => {
  const signal = c.req.raw.signal;
  let body: OpenTaskRequest;
  try {
    body = (await c.req.json()) as OpenTaskRequest;
  } catch {
    return apiError('INVALID_REQUEST', 400, 'Request body must be valid JSON.');
  }

  if (!body?.project) {
    return apiError('MISSING_REQUIRED_FIELD', 400, '`project` is required.');
  }
  if (body.phase !== 'greeting' && body.phase !== 'setup') {
    return apiError('INVALID_REQUEST', 400, "`phase` must be 'greeting' or 'setup'.");
  }

  const authed = await requireUserWithQuota();
  if (typeof authed !== 'string') return authed;
  void recordGeneration(authed);

  let resolved;
  try {
    resolved = await resolveModelFromRequest(withNextUrl(c.req.raw, c.req.url), body, 'pbl-v2-runtime:open-task');
  } catch (err) {
    log.error('Model resolution failed:', err);
    return apiError('INVALID_REQUEST', 400, err instanceof Error ? err.message : String(err));
  }

  const { model, thinkingConfig } = resolved;
  applyRequestLocaleToProject(withNextUrl(c.req.raw, c.req.url), body.project);

  if (body.phase === 'greeting' && body.priorQuizResults && body.priorQuizResults.length > 0) {
    const { updated, tierChanged } = applyQuizSignalsToProject(body.project, body.priorQuizResults);
    if (updated) {
      log.info(
        `Pre-play quiz recalibration: tier=${body.project.proficiency} tierChanged=${tierChanged} quizzes=${body.priorQuizResults.length}`,
      );
    }
  }

  return createSSEResponse(
    runInstructorTurn({ project: body.project, userMessage: '', phase: body.phase, languageModel: model, thinkingConfig, signal }),
    { signal },
  );
});
