/**
 * POST /api/generate-classroom — mirrors app/_api_archive/generate-classroom/route.ts.
 * buildRequestOrigin needs req.nextUrl; bridged via withNextUrl(c.req.raw, c.req.url).
 */
import { Hono } from 'hono';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { type GenerateClassroomInput } from '@/lib/server/classroom-generation';
import { enqueueClassroomJob } from '@/lib/server/queue';
import { buildRequestOrigin } from '@/lib/server/classroom-storage';
import { requireUserWithQuota, recordGeneration } from '@/lib/server/quota';
import { createLogger } from '@/lib/logger';
import { authMiddleware, type AuthVars } from '../server/auth';
import { withNextUrl } from '../server/request';

const log = createLogger('GenerateClassroom API');

export const generateClassroomRoute = new Hono<AuthVars>();
// ponytail: auth scoped to POST via inline route middleware, NOT `use('*', auth)`.
// A wildcard `use` here would also cover the sibling /api/generate-classroom/:jobId
// mount (a child path) and wrongly demand a Bearer on the public job-status GET.
generateClassroomRoute.post('/', authMiddleware, async (c) => {
  let requirementSnippet: string | undefined;
  try {
    const rawBody = (await c.req.json()) as Partial<GenerateClassroomInput>;
    requirementSnippet = rawBody.requirement?.substring(0, 60);
    const body: GenerateClassroomInput = {
      requirement: rawBody.requirement || '',
      ...(rawBody.pdfContent ? { pdfContent: rawBody.pdfContent } : {}),
      ...(rawBody.enableWebSearch != null ? { enableWebSearch: rawBody.enableWebSearch } : {}),
      ...(rawBody.webSearchProviderId ? { webSearchProviderId: rawBody.webSearchProviderId } : {}),
      ...(rawBody.webSearchApiKey ? { webSearchApiKey: rawBody.webSearchApiKey } : {}),
      ...(rawBody.baiduSubSources ? { baiduSubSources: rawBody.baiduSubSources } : {}),
      ...(rawBody.enableImageGeneration != null ? { enableImageGeneration: rawBody.enableImageGeneration } : {}),
      ...(rawBody.enableVideoGeneration != null ? { enableVideoGeneration: rawBody.enableVideoGeneration } : {}),
      ...(rawBody.enableTTS != null ? { enableTTS: rawBody.enableTTS } : {}),
      ...(rawBody.agentMode ? { agentMode: rawBody.agentMode } : {}),
    };
    const { requirement } = body;

    if (!requirement) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required field: requirement');
    }

    const authed = await requireUserWithQuota();
    if (typeof authed !== 'string') return authed;
    void recordGeneration(authed);

    const baseUrl = buildRequestOrigin(withNextUrl(c.req.raw, c.req.url));
    const jobId = await enqueueClassroomJob(body, baseUrl, authed);
    const pollUrl = `${baseUrl}/api/generate-classroom/${jobId}`;

    return apiSuccess(
      { jobId, status: 'queued', step: 'queued', message: 'Classroom generation job queued', pollUrl, pollIntervalMs: 5000 },
      202,
    );
  } catch (error) {
    log.error(`Classroom generation job creation failed [requirement="${requirementSnippet ?? 'unknown'}..."]:`, error);
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Failed to create classroom generation job',
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
});
