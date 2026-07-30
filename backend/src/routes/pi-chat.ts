import { Hono } from 'hono';

import { POST } from '@/app/_api_archive/chat/pi/route';
import { assertGenerationQuota, recordGeneration } from '@/lib/server/quota';
import { checkRateLimit } from '@/lib/server/rate-limit';
import { authMiddleware, type AuthVars } from '../server/auth';
import { withNextUrl } from '../server/request';

export const piChatRoute = new Hono<AuthVars>();
piChatRoute.use('*', authMiddleware);

piChatRoute.post('/', async (c) => {
  const userId = c.get('userId');
  const overRate = await checkRateLimit(userId);
  if (overRate) return overRate;
  const overQuota = await assertGenerationQuota(userId);
  if (overQuota) return overQuota;
  void recordGeneration(userId);

  return POST(withNextUrl(c.req.raw, c.req.url));
});
