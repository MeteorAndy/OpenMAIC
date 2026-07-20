/**
 * POST /api/pbl/chat — mirrors app/_api_archive/pbl/chat/route.ts. HTTP layer only.
 */
import { Hono } from 'hono';
import { callLLM } from '@/lib/ai/llm';
import type { PBLAgent, PBLIssue } from '@/lib/pbl/types';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { requireUserWithQuota, recordGeneration } from '@/lib/server/quota';
import { authMiddleware, type AuthVars } from '../server/auth';
import { withNextUrl } from '../server/request';

const log = createLogger('PBL Chat');

interface PBLChatRequest {
  message: string;
  agent: PBLAgent;
  currentIssue: PBLIssue | null;
  recentMessages: { agent_name: string; message: string }[];
  userRole: string;
  agentType?: 'question' | 'judge';
}

export const pblChatRoute = new Hono<AuthVars>();
pblChatRoute.use('*', authMiddleware);

pblChatRoute.post('/', async (c) => {
  let agentName: string | undefined;
  let resolvedAgentType: string | undefined;
  try {
    const body = (await c.req.json()) as PBLChatRequest;
    const { message, agent, currentIssue, recentMessages, userRole, agentType } = body;
    agentName = agent?.name;
    resolvedAgentType = agentType;

    if (!message || !agent) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Message and agent are required');
    }

    const authed = await requireUserWithQuota();
    if (typeof authed !== 'string') return authed;
    void recordGeneration(authed);

    const { model, thinkingConfig } = await resolveModelFromRequest(withNextUrl(c.req.raw, c.req.url), body, 'pbl-chat');

    let issueContext = '';
    if (currentIssue) {
      issueContext = `\n\n## Current Issue\nTitle: ${currentIssue.title}\nDescription: ${currentIssue.description}\nPerson in Charge: ${currentIssue.person_in_charge}`;
      if (currentIssue.generated_questions) {
        if (agentType === 'judge') {
          issueContext += `\n\nQuestions to Evaluate Against:\n${currentIssue.generated_questions}`;
        } else {
          issueContext += `\n\nGenerated Questions:\n${currentIssue.generated_questions}`;
        }
      }
    }

    const recentContext =
      recentMessages.length > 0
        ? `\n\n## Recent Conversation\n${recentMessages.slice(-5).map((m) => `${m.agent_name}: ${m.message}`).join('\n')}`
        : '';

    const systemPrompt = `${agent.system_prompt}${issueContext}${recentContext}${userRole ? `\n\nThe student's role is: ${userRole}` : ''}`;

    const result = await callLLM({ model, system: systemPrompt, prompt: message }, 'pbl-chat', undefined, thinkingConfig);

    return apiSuccess({ message: result.text, agentName: agent.name });
  } catch (error) {
    log.error(`PBL chat failed [agent="${agentName ?? 'unknown'}", type=${resolvedAgentType ?? 'question'}]:`, error);
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : String(error));
  }
});
