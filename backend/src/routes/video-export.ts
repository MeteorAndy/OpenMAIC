import { Hono } from 'hono';

import { GET as getCapability } from '@/app/_api_archive/export-video/capability/route';
import { POST as submitRender } from '@/app/_api_archive/export-video/render/route';
import {
  DELETE as cancelRender,
  GET as getRender,
} from '@/app/_api_archive/export-video/render/[jobId]/route';
import { GET as downloadRender } from '@/app/_api_archive/export-video/render/[jobId]/download/route';
import { authMiddleware, type AuthVars } from '../server/auth';
import { withNextUrl } from '../server/request';

export const videoExportRoute = new Hono<AuthVars>();
videoExportRoute.use('*', authMiddleware);

videoExportRoute.get('/capability', () => getCapability());
videoExportRoute.post('/render', (c) => submitRender(withNextUrl(c.req.raw, c.req.url)));
videoExportRoute.get('/render/:jobId', (c) =>
  getRender(withNextUrl(c.req.raw, c.req.url), {
    params: Promise.resolve({ jobId: c.req.param('jobId') }),
  }),
);
videoExportRoute.delete('/render/:jobId', (c) =>
  cancelRender(withNextUrl(c.req.raw, c.req.url), {
    params: Promise.resolve({ jobId: c.req.param('jobId') }),
  }),
);
videoExportRoute.get('/render/:jobId/download', (c) =>
  downloadRender(withNextUrl(c.req.raw, c.req.url), {
    params: Promise.resolve({ jobId: c.req.param('jobId') }),
  }),
);
