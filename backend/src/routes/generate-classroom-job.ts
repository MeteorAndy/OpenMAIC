/**
 * GET /api/generate-classroom/:jobId — mirrors app/_api_archive/generate-classroom/[jobId]/route.ts.
 * Public (mirrors Next route, which had no session gate). jobId via c.req.param.
 */
import { Hono } from 'hono';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { getJobStatus, isValidClassroomJobId } from '@/lib/server/queue';
import { buildRequestOrigin } from '@/lib/server/classroom-storage';
import { createLogger } from '@/lib/logger';
import { withNextUrl } from '../server/request';

const log = createLogger('ClassroomJob API');

export const generateClassroomJobRoute = new Hono();

// Mounted at /api/generate-classroom/:jobId, so :jobId comes from the mount path.
generateClassroomJobRoute.get('/', async (c) => {
  let resolvedJobId: string | undefined;
  try {
    const jobId = c.req.param('jobId');
    resolvedJobId = jobId;

    if (!jobId || !isValidClassroomJobId(jobId)) {
      return apiError('INVALID_REQUEST', 400, 'Invalid classroom generation job id');
    }

    const job = await getJobStatus(jobId);
    if (!job) {
      return apiError('INVALID_REQUEST', 404, 'Classroom generation job not found');
    }

    const pollUrl = `${buildRequestOrigin(withNextUrl(c.req.raw, c.req.url))}/api/generate-classroom/${jobId}`;

    return apiSuccess({ ...job, pollUrl });
  } catch (error) {
    log.error(`Classroom job retrieval failed [jobId=${resolvedJobId ?? 'unknown'}]:`, error);
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Failed to retrieve classroom generation job',
      error instanceof Error ? error.message : String(error),
    );
  }
});
