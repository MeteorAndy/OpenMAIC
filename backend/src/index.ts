/**
 * OpenMAIC compiled backend — Hono on Bun.
 *
 * Phase-1 foundation: mounts the three representative routes
 *   GET  /api/health   (public JSON envelope)
 *   GET  /api/quota    (auth + Drizzle + Supabase plan/usage)
 *   POST /api/chat     (auth + rate-limit + quota + SSE through statelessGenerate)
 *
 * All server logic is reused NEAR-VERBATIM from lib/* and db/*; only the three
 * Next-coupled shims are replaced (api-response via next/server shim,
 * session/supabase-server via Bearer resolvers — see tsconfig paths). Hono
 * returns Web Response instances unchanged, so apiSuccess/apiError and the SSE
 * Response(readable) pass straight through.
 *
 * Compile: `bun build src/index.ts --compile --target=bun-<os>-<arch>-modern`
 * Run:     the binary reads env (DATABASE_URL, REDIS_URL, JWT_SECRET, provider
 *          keys, ...) at runtime from Bun.env/process.env — nothing is baked.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { health } from './routes/health';
import { quota } from './routes/quota';
import { chat } from './routes/chat';

const app = new Hono();

// ponytail: permissive CORS — Phase-3 frontend rewire will tighten this to the
// Next origin (or proxy same-origin via next.config rewrite and drop CORS).
app.use(
  '/api/*',
  cors({
    origin: (origin) => origin, // echo request origin (credentials-free Bearer auth)
    allowHeaders: [
      'Content-Type',
      'Authorization',
      'x-model',
      'x-api-key',
      'x-base-url',
      'x-provider-type',
    ],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
  }),
);

app.route('/api/health', health);
app.route('/api/quota', quota);
app.route('/api/chat', chat);

app.notFound((c) =>
  c.json({ success: false, errorCode: 'NOT_FOUND', error: `Route ${c.req.method} ${c.req.path} not found` }, 404),
);

app.onError((err, c) => {
  console.error('[backend] unhandled error:', err);
  return c.json(
    { success: false, errorCode: 'INTERNAL_ERROR', error: err instanceof Error ? err.message : 'Internal error' },
    500,
  );
});

const port = Number(process.env.PORT ?? process.env.BACKEND_PORT ?? 8787);

const server = Bun.serve({
  port,
  fetch: app.fetch,
  // ponytail: Bun.serve's default idleTimeout is 10s, which kills SSE streams
  // (chat/agent-edit/scene-outlines/classroom-media) mid-generation. 255 is the
  // max; the per-route 15s heartbeat keeps the connection non-idle anyway.
  idleTimeout: 255,
});

console.log(`[openmaic-backend] listening on http://0.0.0.0:${server.port} (pid ${process.pid})`);

// ponytail: NO default export — Bun's --compile wrapper auto-serves a default
// export that has a .fetch (a Hono app), which double-binds the port. Keeping
// the explicit Bun.serve above as the single server start for both `bun run`
// and the compiled binary.
export { server };
