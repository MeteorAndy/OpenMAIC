/**
 * POST /api/pbl/v2/task/update — mirrors app/api/pbl/v2/task/update/route.ts.
 * Pure state mutation; no LLM. Authed (quota gate kept faithful to Next route).
 */
import { Hono } from 'hono';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  startMicrotask,
  continueAfterHandover,
  currentMicrotask,
  advanceMicrotask,
  completeRoleplayAct,
  appendTaskDividerMessage,
} from '@/lib/pbl/v2/operations/progress';
import type { PBLProjectV2 } from '@/lib/pbl/v2/types';
import { currentPendingTaskCompletion } from '@/lib/pbl/v2/operations/task-completion';
import { requireUserWithQuota, recordGeneration } from '@/lib/server/quota';
import { authMiddleware, type AuthVars } from '../server/auth';

interface UpdateRequest {
  project: PBLProjectV2;
  action: 'start' | 'continue_handover' | 'enter_scenario' | 'complete_act' | 'complete_pending_task';
  microtaskId?: string;
}

export const pblV2TaskUpdateRoute = new Hono<AuthVars>();
pblV2TaskUpdateRoute.use('*', authMiddleware);

pblV2TaskUpdateRoute.post('/', async (c) => {
  let body: UpdateRequest;
  try {
    body = (await c.req.json()) as UpdateRequest;
  } catch {
    return apiError('INVALID_REQUEST', 400, 'Request body must be valid JSON.');
  }
  if (!body?.project) {
    return apiError('MISSING_REQUIRED_FIELD', 400, '`project` is required.');
  }

  const authed = await requireUserWithQuota();
  if (typeof authed !== 'string') return authed;
  void recordGeneration(authed);

  const project = body.project;

  switch (body.action) {
    case 'start': {
      if (!body.microtaskId) {
        return apiError('MISSING_REQUIRED_FIELD', 400, '`microtaskId` is required for start.');
      }
      startMicrotask(project, body.microtaskId);
      return apiSuccess({ project });
    }
    case 'continue_handover': {
      const r = continueAfterHandover(project);
      if (!r.ok) {
        return apiError('INVALID_REQUEST', 400, 'No pending handover to consume.');
      }
      return apiSuccess({ project, activatedMicrotaskId: r.activatedMicrotaskId });
    }
    case 'complete_pending_task': {
      const current = currentMicrotask(project);
      if (!current) {
        return apiError('INVALID_REQUEST', 400, 'No active microtask to complete.');
      }
      const pending = currentPendingTaskCompletion(project, current.microtask.id);
      if (!pending) {
        return apiError('INVALID_REQUEST', 400, 'No pending task completion to confirm.');
      }
      const adv = advanceMicrotask(project, current.microtask.id, pending.reason, pending.assessment ?? {});
      if (!adv.ok) {
        return apiError('INVALID_REQUEST', 400, `Could not complete task: ${adv.error}`);
      }
      const nextTask = adv.nextMicrotaskId
        ? current.milestone.microtasks.find((task) => task.id === adv.nextMicrotaskId)
        : undefined;
      appendTaskDividerMessage(project, {
        completedMicrotaskId: current.microtask.id,
        nextMicrotaskId: adv.nextMicrotaskId,
        completedTitle: current.microtask.title,
        nextTitle: nextTask?.title,
      });
      return apiSuccess({
        project,
        completedMicrotaskId: current.microtask.id,
        milestoneId: current.milestone.id,
        milestoneCompleted: adv.milestoneCompleted,
        projectCompleted: adv.projectCompleted,
        nextMicrotaskId: adv.nextMicrotaskId,
      });
    }
    case 'enter_scenario': {
      if (!project.scenario) {
        return apiError('INVALID_REQUEST', 400, 'Not a scenario project.');
      }
      const current = currentMicrotask(project);
      if (!current || current.milestone.scenarioStage !== 'prep') {
        return apiError('INVALID_REQUEST', 400, 'No active scenario prep stage to advance.');
      }
      const adv = advanceMicrotask(project, current.microtask.id, 'entered_scenario', {});
      if (!adv.ok) {
        return apiError('INVALID_REQUEST', 400, `Could not complete prep stage: ${adv.error}`);
      }
      const cont = continueAfterHandover(project);
      return apiSuccess({
        project,
        activatedMicrotaskId: cont.ok ? cont.activatedMicrotaskId : undefined,
      });
    }
    case 'complete_act': {
      if (!project.scenario) {
        return apiError('INVALID_REQUEST', 400, 'Not a scenario project.');
      }
      const r = completeRoleplayAct(project, 'act_completed_by_learner');
      if (!r.ok) {
        return apiError('INVALID_REQUEST', 400, `Could not finish act: ${r.error}`);
      }
      return apiSuccess({ project });
    }
    default:
      return apiError('INVALID_REQUEST', 400, `Unknown action: ${String(body.action)}`);
  }
});
