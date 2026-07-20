/**
 * POST /api/pbl/v2/simulator — mirrors app/_api_archive/pbl/v2/simulator/route.ts. SSE.
 */
import { Hono } from 'hono';
import { createLogger } from '@/lib/logger';
import { apiError } from '@/lib/server/api-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { createSSEResponse } from '@/lib/pbl/v2/api/sse';
import { applyRequestLocaleToProject } from '@/lib/pbl/v2/api/locale';
import { runSimulatorTurn, type SimulatorPhase } from '@/lib/pbl/v2/agents/simulator';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';
import { requireUserWithQuota, recordGeneration } from '@/lib/server/quota';
import { authMiddleware, type AuthVars } from '../server/auth';
import { withNextUrl } from '../server/request';

const log = createLogger('PBL v2 Simulator API');

interface SimulatorRequest {
  project: PBLProjectV2;
  userMessage?: string;
  phase?: SimulatorPhase;
}

export const pblV2SimulatorRoute = new Hono<AuthVars>();
pblV2SimulatorRoute.use('*', authMiddleware);

pblV2SimulatorRoute.post('/', async (c) => {
  const signal = c.req.raw.signal;
  let body: SimulatorRequest;
  try {
    body = (await c.req.json()) as SimulatorRequest;
  } catch {
    return apiError('INVALID_REQUEST', 400, 'Request body must be valid JSON.');
  }

  if (!body?.project) {
    return apiError('MISSING_REQUIRED_FIELD', 400, '`project` is required.');
  }

  const authed = await requireUserWithQuota();
  if (typeof authed !== 'string') return authed;
  void recordGeneration(authed);

  let resolved;
  try {
    resolved = await resolveModelFromRequest(withNextUrl(c.req.raw, c.req.url), body, 'pbl-v2-runtime:simulator');
  } catch (err) {
    log.error('Model resolution failed:', err);
    return apiError('INVALID_REQUEST', 400, err instanceof Error ? err.message : String(err));
  }

  const { model, thinkingConfig } = resolved;
  const phase: SimulatorPhase = body.phase === 'greeting' ? 'greeting' : 'instructing';
  applyRequestLocaleToProject(withNextUrl(c.req.raw, c.req.url), body.project);

  return createSSEResponse(
    runSimulatorTurn({ project: body.project, userMessage: body.userMessage ?? '', phase, languageModel: model, thinkingConfig, signal }),
    { signal },
  );
});
