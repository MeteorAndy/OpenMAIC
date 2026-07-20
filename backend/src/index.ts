/**
 * OpenMAIC compiled backend — Hono on Bun.
 *
 * All Next.js API routes are ported here. Each sub-app under backend/src/routes/
 * mirrors an app/_api_archive/<path>/route.ts handler, reusing lib/* and db/* verbatim;
 * only the HTTP layer is adapted (Hono Context in place of NextRequest). Hono
 * returns Web Response instances unchanged, so apiSuccess/apiError and the SSE
 * Response(readable) pass straight through.
 *
 * Compile: `bun build src/index.ts --compile --target=bun-<os>-<arch>-modern`
 * Run:     the binary reads env at runtime from Bun.env/process.env — nothing baked.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { health } from './routes/health';
import { quota } from './routes/quota';
import { chat } from './routes/chat';
// generate/*
import { generateImageRoute } from './routes/generate-image';
import { generateTtsRoute } from './routes/generate-tts';
import { generateVideoRoute } from './routes/generate-video';
import { generateVoiceRoute } from './routes/generate-voice';
import { generateSceneContentRoute } from './routes/generate-scene-content';
import { generateSceneActionsRoute } from './routes/generate-scene-actions';
import { generateSceneOutlinesStreamRoute } from './routes/generate-scene-outlines-stream';
import { generateAgentProfilesRoute } from './routes/generate-agent-profiles';
// pbl/*
import { pblChatRoute } from './routes/pbl-chat';
import { pblV2EvaluateRoute } from './routes/pbl-v2-evaluate';
import { pblV2InstructorRoute } from './routes/pbl-v2-instructor';
import { pblV2OpenTaskRoute } from './routes/pbl-v2-open-task';
import { pblV2SimulatorRoute } from './routes/pbl-v2-simulator';
import { pblV2TaskUpdateRoute } from './routes/pbl-v2-task-update';
// agent / misc authed
import { agentEditRoute } from './routes/agent-edit';
import { quizGradeRoute } from './routes/quiz-grade';
import { webSearchRoute } from './routes/web-search';
import { transcriptionRoute } from './routes/transcription';
import { generateClassroomRoute } from './routes/generate-classroom';
import { assetsUploadRoute } from './routes/assets-upload';
// public
import { generateClassroomJobRoute } from './routes/generate-classroom-job';
import { classroomRoute } from './routes/classroom';
import { classroomMediaRoute } from './routes/classroom-media';
import { serverProvidersRoute } from './routes/server-providers';
import { usageRoute } from './routes/usage';
import { azureVoicesRoute } from './routes/azure-voices';
import { verifyModelRoute } from './routes/verify-model';
import { verifyImageProviderRoute } from './routes/verify-image-provider';
import { verifyVideoProviderRoute } from './routes/verify-video-provider';
import { verifyPdfProviderRoute } from './routes/verify-pdf-provider';
import { parsePdfRoute } from './routes/parse-pdf';
import { extractDocumentRoute } from './routes/extract-document';
import { proxyMediaRoute } from './routes/proxy-media';
import { comfyuiWorkflowsRoute } from './routes/comfyui-workflows';
import { providerProbeModelsRoute } from './routes/provider-probe-models';
import { accessCodeStatusRoute, accessCodeVerifyRoute } from './routes/access-code';

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

// Already ported in Phase 1.
app.route('/api/health', health);
app.route('/api/quota', quota);
app.route('/api/chat', chat);

// generate/*
app.route('/api/generate/image', generateImageRoute);
app.route('/api/generate/tts', generateTtsRoute);
app.route('/api/generate/video', generateVideoRoute);
app.route('/api/generate/voice', generateVoiceRoute);
app.route('/api/generate/scene-content', generateSceneContentRoute);
app.route('/api/generate/scene-actions', generateSceneActionsRoute);
app.route('/api/generate/scene-outlines-stream', generateSceneOutlinesStreamRoute);
app.route('/api/generate/agent-profiles', generateAgentProfilesRoute);

// pbl/*
app.route('/api/pbl/chat', pblChatRoute);
app.route('/api/pbl/v2/evaluate', pblV2EvaluateRoute);
app.route('/api/pbl/v2/instructor', pblV2InstructorRoute);
app.route('/api/pbl/v2/open-task', pblV2OpenTaskRoute);
app.route('/api/pbl/v2/simulator', pblV2SimulatorRoute);
app.route('/api/pbl/v2/task/update', pblV2TaskUpdateRoute);

// agent / misc authed
app.route('/api/agent/edit', agentEditRoute);
app.route('/api/quiz-grade', quizGradeRoute);
app.route('/api/web-search', webSearchRoute);
app.route('/api/transcription', transcriptionRoute);
app.route('/api/generate-classroom', generateClassroomRoute);
app.route('/api/assets/upload', assetsUploadRoute);

// public
app.route('/api/generate-classroom/:jobId', generateClassroomJobRoute);
app.route('/api/classroom', classroomRoute);
app.route('/api/classroom-media', classroomMediaRoute);
app.route('/api/server-providers', serverProvidersRoute);
app.route('/api/usage', usageRoute);
app.route('/api/azure-voices', azureVoicesRoute);
app.route('/api/verify-model', verifyModelRoute);
app.route('/api/verify-image-provider', verifyImageProviderRoute);
app.route('/api/verify-video-provider', verifyVideoProviderRoute);
app.route('/api/verify-pdf-provider', verifyPdfProviderRoute);
app.route('/api/parse-pdf', parsePdfRoute);
app.route('/api/extract-document', extractDocumentRoute);
app.route('/api/proxy-media', proxyMediaRoute);
app.route('/api/comfyui-workflows', comfyuiWorkflowsRoute);
app.route('/api/provider/probe-models', providerProbeModelsRoute);
app.route('/api/access-code/status', accessCodeStatusRoute);
app.route('/api/access-code/verify', accessCodeVerifyRoute);

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
