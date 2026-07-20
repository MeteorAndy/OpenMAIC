/**
 * POST /api/pbl/v2/evaluate — mirrors app/_api_archive/pbl/v2/evaluate/route.ts.
 * SSE via createSSEResponse; signal from c.req.raw.signal.
 */
import { Hono } from 'hono';
import { createLogger } from '@/lib/logger';
import { apiError } from '@/lib/server/api-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { createSSEResponse } from '@/lib/pbl/v2/api/sse';
import { runFinalEvaluation, runMilestoneEvaluation, runTaskEvaluation } from '@/lib/pbl/v2/agents/evaluator';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';
import { requireUserWithQuota, recordGeneration } from '@/lib/server/quota';
import { authMiddleware, type AuthVars } from '../server/auth';
import { withNextUrl } from '../server/request';

const log = createLogger('PBL v2 Evaluate API');

type EvalKind = 'task' | 'milestone' | 'final';

interface EvaluateRequest {
  project: PBLProjectV2;
  kind: EvalKind;
  milestoneId?: string;
  microtaskId?: string;
  recentChatSummary?: string;
}

export const pblV2EvaluateRoute = new Hono<AuthVars>();
pblV2EvaluateRoute.use('*', authMiddleware);

pblV2EvaluateRoute.post('/', async (c) => {
  const signal = c.req.raw.signal;
  let body: EvaluateRequest;
  try {
    body = (await c.req.json()) as EvaluateRequest;
  } catch {
    return apiError('INVALID_REQUEST', 400, 'Request body must be valid JSON.');
  }

  if (!body?.project) {
    return apiError('MISSING_REQUIRED_FIELD', 400, '`project` is required.');
  }
  if (body.kind !== 'task' && body.kind !== 'milestone' && body.kind !== 'final') {
    return apiError('INVALID_REQUEST', 400, "`kind` must be 'task' | 'milestone' | 'final'.");
  }
  if (body.kind === 'task' && (!body.milestoneId || !body.microtaskId)) {
    return apiError('MISSING_REQUIRED_FIELD', 400, "kind='task' requires both milestoneId and microtaskId.");
  }
  if (body.kind === 'milestone' && !body.milestoneId) {
    return apiError('MISSING_REQUIRED_FIELD', 400, "kind='milestone' requires milestoneId.");
  }

  const authed = await requireUserWithQuota();
  if (typeof authed !== 'string') return authed;
  void recordGeneration(authed);

  let resolved;
  try {
    resolved = await resolveModelFromRequest(withNextUrl(c.req.raw, c.req.url), body, 'pbl-v2-runtime:evaluate');
  } catch (err) {
    log.error('Model resolution failed:', err);
    return apiError('INVALID_REQUEST', 400, err instanceof Error ? err.message : String(err));
  }
  const { model, thinkingConfig, modelInfo } = resolved;
  const hasVision = !!modelInfo?.capabilities?.vision;

  if (body.kind === 'task') {
    return createSSEResponse(
      runTaskEvaluation({
        project: body.project,
        milestoneId: body.milestoneId!,
        microtaskId: body.microtaskId!,
        languageModel: model,
        thinkingConfig,
        recentChatSummary: body.recentChatSummary,
        hasVision,
        signal,
      }),
      { signal },
    );
  }
  if (body.kind === 'milestone') {
    return createSSEResponse(
      runMilestoneEvaluation({
        project: body.project,
        milestoneId: body.milestoneId!,
        languageModel: model,
        thinkingConfig,
        recentChatSummary: body.recentChatSummary,
        signal,
      }),
      { signal },
    );
  }
  return createSSEResponse(
    runFinalEvaluation({
      project: body.project,
      languageModel: model,
      thinkingConfig,
      recentChatSummary: body.recentChatSummary,
      signal,
    }),
    { signal },
  );
});
