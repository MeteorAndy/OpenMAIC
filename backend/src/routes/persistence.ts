import { Hono } from 'hono';

import { handlePersistenceRequest } from '@/app/_api_archive/persistence/[...path]/route';

export const persistenceRoute = new Hono();

persistenceRoute.all('*', (c) => handlePersistenceRequest(c.req.raw));
