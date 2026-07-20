/**
 * POST /api/agent/edit — mirrors app/_api_archive/agent/edit/route.ts.
 * SSE transport for the pi Agent; inline ReadableStream + subscribe. The stream's
 * cancel() (fired on client disconnect via Hono's raw Request) aborts the agent.
 */
import { Hono } from 'hono';
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import { isMaicEditorEnabled } from '@/lib/config/feature-flags';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import type { LlmStage } from '@/lib/server/model-routes';
import { createCallLlmStreamFn } from '@/lib/agent/runtime/stream-fn';
import { buildAgent, buildSystemPrompt } from '@/lib/agent/runtime/build-agent';
import { buildToolset } from '@/lib/agent/tools/registry';
import { callLLM } from '@/lib/ai/llm';
import { createLogger } from '@/lib/logger';
import type { SceneContext } from '@/lib/agent/tools/regenerate-scene-actions';
import { requireUserWithQuota, recordGeneration } from '@/lib/server/quota';
import { authMiddleware, type AuthVars } from '../server/auth';
import { withNextUrl } from '../server/request';

const log = createLogger('MAIC Agent');

export type SceneContextMap = Record<string, SceneContext>;

interface AgentEditBody {
  message: string;
  scene?: { id: string; title: string };
  history?: Array<{ role: 'user' | 'assistant'; text: string }>;
  sceneContextMap?: SceneContextMap;
}

const MAX_HISTORY_TURNS = 24;

function toHistoryMessages(history: AgentEditBody['history']): AgentMessage[] {
  if (!Array.isArray(history)) return [];
  const turns = history
    .filter(
      (m): m is { role: 'user' | 'assistant'; text: string } =>
        !!m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.trim().length > 0,
    )
    .slice(-MAX_HISTORY_TURNS);
  while (turns.length > 0 && turns[turns.length - 1].role === 'user') turns.pop();
  return turns.map((m) =>
    m.role === 'user'
      ? ({ role: 'user', content: m.text } as AgentMessage)
      : ({ role: 'assistant', content: [{ type: 'text', text: m.text }] } as AgentMessage),
  );
}

export const agentEditRoute = new Hono<AuthVars>();
agentEditRoute.use('*', authMiddleware);

agentEditRoute.post('/', async (c) => {
  if (!isMaicEditorEnabled()) {
    return new Response('Not found', { status: 404 });
  }

  const body = (await c.req.json()) as AgentEditBody & Record<string, unknown>;
  const message = (body.message ?? '').toString().trim();
  if (!message) {
    return new Response('message is required', { status: 400 });
  }

  const authed = await requireUserWithQuota();
  if (typeof authed !== 'string') return authed;
  void recordGeneration(authed);

  const { model, modelInfo, thinkingConfig, modelString } = await resolveModelFromRequest(
    withNextUrl(c.req.raw, c.req.url),
    body,
    'maic-agent',
  );

  const stageCache = new Map<LlmStage, Awaited<ReturnType<typeof resolveModelFromRequest>>>();
  const aiCall = async (stage: LlmStage, system: string, prompt: string, signal?: AbortSignal): Promise<string> => {
    let resolved = stageCache.get(stage);
    if (!resolved) {
      resolved = await resolveModelFromRequest(withNextUrl(c.req.raw, c.req.url), body, stage);
      stageCache.set(stage, resolved);
    }
    const r = await callLLM(
      { model: resolved.model, system, prompt, maxOutputTokens: resolved.modelInfo?.outputWindow, abortSignal: signal },
      'maic-agent-regen',
      undefined,
      resolved.thinkingConfig,
    );
    return r.text;
  };

  const sceneContextMap: SceneContextMap = body.sceneContextMap ?? {};
  const tools = buildToolset({
    aiCall,
    getSceneContext: (sceneId) => sceneContextMap[sceneId],
    activeSceneId: body.scene?.id,
  });

  const abortController = new AbortController();
  const streamFn = createCallLlmStreamFn({
    languageModel: model,
    maxOutputTokens: modelInfo?.outputWindow,
    thinkingConfig,
    source: 'maic-agent',
    abortSignal: abortController.signal,
  });

  const agent = buildAgent({
    streamFn,
    systemPrompt: buildSystemPrompt(body.scene),
    tools,
    history: toHistoryMessages(body.history),
  });
  log.info(`agent edit turn [model=${modelString}] scene=${body.scene?.id ?? 'none'}`);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: AgentEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          /* controller closed */
        }
      };
      const unsubscribe = agent.subscribe((event) => {
        send(event);
      });
      try {
        await agent.prompt(message);
        await agent.waitForIdle();
      } catch (err) {
        log.error(`agent run failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        unsubscribe();
        try {
          controller.enqueue(encoder.encode('event: close\ndata: {}\n\n'));
        } catch {
          /* ignore */
        }
        controller.close();
      }
    },
    cancel() {
      agent.abort();
      abortController.abort();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
});
