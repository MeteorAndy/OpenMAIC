/**
 * POST /api/chat — stateless SSE generation. Mirrors app/_api_archive/chat/route.ts.
 *
 * Only the HTTP layer is adapted (Hono Context in place of NextRequest);
 * everything beneath — requireUserWithQuota (auth+rate-limit+quota gate),
 * resolveModel, statelessGenerate -> LangGraph -> @ai-sdk -> pi-agent — is
 * reused unchanged. The SSE TransformStream + 15s heartbeat + abort-on-
 * disconnect are identical: Hono returns the raw Response(readable) verbatim,
 * and c.req.raw.signal is the native Request signal (same as req.signal).
 */
import { Hono } from 'hono';
import { statelessGenerate } from '@/lib/orchestration/stateless-generate';
import { isProviderKeyRequired } from '@/lib/ai/providers';
import type { StatelessChatRequest, StatelessEvent } from '@/lib/types/chat';
import { apiError } from '@/lib/server/api-response';
import { assertGenerationQuota, recordGeneration } from '@/lib/server/quota';
import { checkRateLimit } from '@/lib/server/rate-limit';
import { createLogger } from '@/lib/logger';
import { resolveModel } from '@/lib/server/resolve-model';
import type { ThinkingConfig } from '@/lib/types/provider';
import { authMiddleware, type AuthVars } from '../server/auth';

const log = createLogger('Chat API');

export const chat = new Hono<AuthVars>();
chat.use('*', authMiddleware);

chat.post('/', async (c) => {
  const encoder = new TextEncoder();
  let chatModel: string | undefined;
  let chatMessageCount: number | undefined;

  try {
    const body: StatelessChatRequest = await c.req.json();
    chatModel = body.model;
    chatMessageCount = body.messages?.length;

    if (!body.messages || !Array.isArray(body.messages)) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required field: messages');
    }
    if (!body.storeState) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required field: storeState');
    }
    if (!body.config || !body.config.agentIds || body.config.agentIds.length === 0) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required field: config.agentIds');
    }

    // SaaS gate: rate-limit + generation quota. userId is already validated by
    // the Bearer authMiddleware (c.get('userId')) — no need to re-derive a
    // cookie session, which keeps the backend off next/headers entirely.
    const userId = c.get('userId');
    const overRate = await checkRateLimit(userId);
    if (overRate) return overRate;
    const overQuota = await assertGenerationQuota(userId);
    if (overQuota) return overQuota;
    void recordGeneration(userId);

    const {
      model: languageModel,
      apiKey: resolvedApiKey,
      providerId,
      thinkingConfig: resolvedThinking,
    } = await resolveModel({
      modelString: body.model,
      stage: 'chat-adapter',
      apiKey: body.apiKey,
      baseUrl: body.baseUrl,
      providerType: body.providerType,
      thinkingConfig: body.thinkingConfig ?? body.thinking,
    });

    if (isProviderKeyRequired(providerId) && !resolvedApiKey) {
      return apiError('MISSING_API_KEY', 401, 'API Key is required');
    }

    log.info('Processing request');
    log.info(
      `Agents: ${body.config.agentIds.join(', ')}, Messages: ${body.messages.length}, Turn: ${body.directorState?.turnCount ?? 0}`,
    );

    // Native Request signal — same abort semantics as NextRequest.signal.
    const signal = c.req.raw.signal;

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    const HEARTBEAT_INTERVAL_MS = 15_000;
    (async () => {
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      const startHeartbeat = () => {
        stopHeartbeat();
        heartbeatTimer = setInterval(() => {
          try {
            writer.write(encoder.encode(`:heartbeat\n\n`)).catch(() => stopHeartbeat());
          } catch {
            stopHeartbeat();
          }
        }, HEARTBEAT_INTERVAL_MS);
      };
      const stopHeartbeat = () => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      };

      try {
        startHeartbeat();

        const thinkingConfig: ThinkingConfig = resolvedThinking ?? {
          mode: 'disabled',
          enabled: false,
        };

        const generator = statelessGenerate(
          { ...body, apiKey: resolvedApiKey },
          signal,
          languageModel,
          thinkingConfig,
        );

        for await (const event of generator) {
          if (signal.aborted) {
            log.info('Request was aborted');
            break;
          }
          const data = `data: ${JSON.stringify(event)}\n\n`;
          await writer.write(encoder.encode(data));
        }

        stopHeartbeat();
        await writer.close();
      } catch (error) {
        stopHeartbeat();
        if (signal.aborted) {
          log.info('Request aborted during streaming');
          try {
            await writer.close();
          } catch {
            /* already closed */
          }
          return;
        }
        log.error(
          `Chat stream error [model=${body.model ?? 'unknown'}, agents=${body.config?.agentIds?.length ?? 0}, messages=${body.messages?.length ?? 0}]:`,
          error,
        );
        try {
          const errorEvent: StatelessEvent = {
            type: 'error',
            data: { message: error instanceof Error ? error.message : String(error) },
          };
          await writer.write(encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`));
          await writer.close();
        } catch {
          /* Writer may already be closed */
        }
      }
    })();

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    log.error(
      `Chat request failed [model=${chatModel ?? 'unknown'}, messages=${chatMessageCount ?? 0}]:`,
      error,
    );
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : 'Failed to process request',
    );
  }
});
