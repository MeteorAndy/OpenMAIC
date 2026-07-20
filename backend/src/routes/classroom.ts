/**
 * /api/classroom — mirrors app/_api_archive/classroom/route.ts. POST persists, GET reads by ?id.
 * Public (classrooms are shared by URL). nextUrl.searchParams -> c.req.query.
 */
import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import { apiSuccess, apiError, API_ERROR_CODES } from '@/lib/server/api-response';
import { buildRequestOrigin, isValidClassroomId, persistClassroom, readClassroom } from '@/lib/server/classroom-storage';
import { createLogger } from '@/lib/logger';
import { withNextUrl } from '../server/request';

const log = createLogger('Classroom API');

export const classroomRoute = new Hono();

classroomRoute.post('/', async (c) => {
  let stageId: string | undefined;
  let sceneCount: number | undefined;
  try {
    const body = await c.req.json();
    const { stage, scenes } = body;
    stageId = stage?.id;
    sceneCount = scenes?.length;

    if (!stage || !scenes) {
      return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, 'Missing required fields: stage, scenes');
    }

    const id = stage.id || randomUUID();
    const baseUrl = buildRequestOrigin(withNextUrl(c.req.raw, c.req.url));

    const persisted = await persistClassroom({ id, stage: { ...stage, id }, scenes }, baseUrl);

    return apiSuccess({ id: persisted.id, url: persisted.url }, 201);
  } catch (error) {
    log.error(`Classroom storage failed [stageId=${stageId ?? 'unknown'}, scenes=${sceneCount ?? 0}]:`, error);
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to store classroom',
      error instanceof Error ? error.message : String(error),
    );
  }
});

classroomRoute.get('/', async (c) => {
  try {
    const id = c.req.query('id');

    if (!id) {
      return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, 'Missing required parameter: id');
    }

    if (!isValidClassroomId(id)) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
    }

    const classroom = await readClassroom(id);
    if (!classroom) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Classroom not found');
    }

    return apiSuccess({ classroom });
  } catch (error) {
    log.error(`Classroom retrieval failed [id=${c.req.query('id') ?? 'unknown'}]:`, error);
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to retrieve classroom',
      error instanceof Error ? error.message : String(error),
    );
  }
});
