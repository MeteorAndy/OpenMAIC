/**
 * Stage Storage Manager
 *
 * Manages multiple stage data in IndexedDB
 * Each stage has its own storage key based on stageId
 */

import { Stage, Scene } from '../types/stage';
import { ChatSession } from '../types/chat';
import {
  saveChatSessions,
  loadChatSessions,
  deleteChatSessions,
  type ChatStorageSnapshot,
} from './chat-storage';
import {
  upsertCourse,
  getCourse,
  replaceScenes,
  getScenes,
  listCourses,
  renameCourse,
  courseExists,
  deleteCourse,
  getFirstSlideByStages as getFirstSlideByStagesFromQueries,
  setCourseOutline,
  type CourseOutline,
} from '@/lib/supabase/queries';
import { clearAllForScene } from '@/lib/quiz/persistence';
import { beginStageRuntimeDeletionSafely } from '@/lib/runtime/store';
import { clearStageDrainWatermarks } from '@/lib/pbl/v2/runtime/drain';
import { createLogger } from '@/lib/logger';
import { clearCursor } from '@/lib/playback/cursor';
import {
  beginStageDeletionCascade,
  isStageDeleted,
  isStageWriteStale,
  markStageDeleted,
  settleStageDeletionCascade,
  unmarkStageDeleted,
} from './deleted-stages';

const log = createLogger('StageStorage');

// ponytail: module-level optimistic-lock guard. Keyed by stageId, holds the raw
// server `updated_at` (opaque ISO) returned by the last course read/write.
// Threaded through saveStageData/loadStageData/renameStage so upsertCourse's
// guarded UPDATE can detect a stale write. undefined => unguarded (last-write-
// wins, byte-identical to the original SaaS path).
const guardByStageId = new Map<string, string>();

type StageStoreOutline =
  | (NonNullable<CourseOutline> & {
      createdAt?: number;
      updatedAt?: number;
    })
  | null;

export interface StageStoreData {
  stage: Stage;
  scenes: Scene[];
  currentSceneId: string | null;
  chats: ChatSession[];
  chatSnapshot?: ChatStorageSnapshot;
  /**
   * course.outline jsonb ({outlines, generationComplete} | null) — single source
   * with the course row. Load-only: populated by loadStageData (for the store's
   * resume-on-mount read). The main editor now sends it through the aggregate
   * save, so it remains optional for older callers.
   */
  outline?: StageStoreOutline;
}

export interface StageListItem {
  id: string;
  name: string;
  description?: string;
  sceneCount: number;
  createdAt: number;
  updatedAt: number;
  interactiveMode?: boolean;
  taskEngineMode?: boolean;
}

export type PendingChange =
  | { kind: 'scene'; sceneId: string }
  | { kind: 'structure' }
  | { kind: 'stage' }
  | { kind: 'outline' }
  | { kind: 'currentScene' }
  | { kind: 'chats' };

export type StaleDroppedSave = 'stale-dropped';

/**
 * Save stage data to Supabase (course + scenes + chats move together).
 */
export async function saveStageData(
  stageId: string,
  data: StageStoreData,
  capturedEpoch?: number,
): Promise<{ failedChanges: PendingChange[] } | StaleDroppedSave | undefined> {
  if (capturedEpoch !== undefined && isStageWriteStale(stageId, capturedEpoch)) {
    log.info(`Dropping save for deleted/stale stage: ${stageId}`);
    return 'stale-dropped';
  }
  try {
    const guard = guardByStageId.get(stageId);
    let newGuard = await upsertCourse(stageId, data.stage, data.currentSceneId || null, guard);
    guardByStageId.set(stageId, newGuard);

    if (capturedEpoch !== undefined && isStageWriteStale(stageId, capturedEpoch)) {
      return 'stale-dropped';
    }

    // Scenes full-replace (delete-by-course + upsert). Guarded at the course
    // level by the upsertCourse above succeeding first.
    await replaceScenes(stageId, data.scenes);

    if (data.outline) {
      newGuard = await setCourseOutline(
        stageId,
        {
          outlines: data.outline.outlines,
          generationComplete: data.outline.generationComplete,
        },
        newGuard,
      );
      guardByStageId.set(stageId, newGuard);
    }

    // Chat sessions persist through the now-delegated chat-storage (Supabase).
    if (data.chats) {
      await saveChatSessions(stageId, data.chats, { backend: 'supabase' });
    }

    log.info(`Saved stage: ${stageId}`);
  } catch (error) {
    log.error('Failed to save stage:', error);
    throw error;
  }
}

/**
 * Supabase exposes the course as one optimistic aggregate, so the SaaS branch
 * deliberately maps main's incremental editor contract onto the established
 * full course/scenes/chat write.
 */
export async function saveStageDataIncremental(
  stageId: string,
  _dirty: readonly PendingChange[],
  data: StageStoreData,
  capturedEpoch: number,
): Promise<{ failedChanges: PendingChange[] } | StaleDroppedSave> {
  const result = await saveStageData(stageId, data, capturedEpoch);
  return result ?? { failedChanges: [] };
}

/**
 * Load stage data from Supabase. Course + scenes read together; guard cached for
 * the next saveStageData. outline comes from the same getCourse call (single
 * round trip) so store.loadFromStorage needs no second query.
 */
export async function loadStageData(stageId: string): Promise<StageStoreData | null> {
  try {
    const got = await getCourse(stageId);
    if (!got) {
      log.info(`Stage not found: ${stageId}`);
      return null;
    }
    const { stage, guard, outline } = got;
    guardByStageId.set(stageId, guard);

    // getScenes already makeScene-binds each row (deriving `type` from
    // content.type) — do NOT re-bind here.
    const { scenes } = await getScenes(stageId);
    const chats = await loadChatSessions(stageId, { backend: 'supabase' });

    log.info(`Loaded stage: ${stageId}, scenes: ${scenes.length}, chats: ${chats.length}`);

    return {
      stage,
      scenes,
      // currentSceneId fallback chain preserved verbatim.
      currentSceneId: stage.currentSceneId || scenes[0]?.id || null,
      chats,
      chatSnapshot: { sessions: structuredClone(chats) },
      outline,
    };
  } catch (error) {
    log.error('Failed to load stage:', error);
    return null;
  }
}

/**
 * Delete stage and all related data.
 * ORDER CRITICAL: scene ids are collected BEFORE deleteCourse, because the
 * CASCADE FK empties Supabase scenes and getScenes would return [] afterwards,
 * causing the per-scene quiz-persistence sweep to miss them.
 */
const inFlightStageDeletions = new Map<string, Promise<void>>();

export function deleteStageData(stageId: string): Promise<void> {
  const existing = inFlightStageDeletions.get(stageId);
  if (existing) return existing;

  const run = performStageDeletion(stageId).finally(() => {
    inFlightStageDeletions.delete(stageId);
  });
  inFlightStageDeletions.set(stageId, run);
  return run;
}

async function performStageDeletion(stageId: string): Promise<void> {
  const {
    clearStoreForDeletedStage,
    discardPendingStageChanges,
    restorePendingStageChanges,
    snapshotPendingStageChangesForDeletion,
  } = await import('@/lib/store/stage');
  const discardedChanges = snapshotPendingStageChangesForDeletion(stageId);
  markStageDeleted(stageId);
  beginStageDeletionCascade(stageId);
  discardPendingStageChanges(stageId);
  let courseDeleted = false;

  try {
    // Collect scene ids before the DB delete (PostgREST read; returns [] if absent).
    const { raw } = await getScenes(stageId);
    const sceneIds = raw.map((s) => s.id);

    // deleteCourse CASCADE-clears DB scene/chat_session/generated_agent/media_file
    // rows (db/c2_prereqs.sql). Device-local cleanup follows.
    await deleteCourse(stageId);
    courseDeleted = true;
    guardByStageId.delete(stageId);

    // Redundant with CASCADE but harmless (idempotent); keeps the chat-storage
    // contract for environments where the FK isn't applied yet.
    await deleteChatSessions(stageId, { backend: 'supabase' });
    try {
      await clearCursor(stageId);
    } catch (error) {
      log.warn(`Failed to clear playback cursor for stage ${stageId}:`, error);
    }

    // Sweep quiz persistence keys for each deleted scene.
    for (const sceneId of sceneIds) {
      clearAllForScene(sceneId);
    }

    // Learner-runtime data lives in a separate IndexedDB database, so it is
    // cascaded after the Supabase work: it cannot join those calls, and a
    // runtime failure must not abort them (the helper warns instead of
    // throwing).
    const runtimeDeletion = beginStageRuntimeDeletionSafely(stageId);
    await runtimeDeletion.completion;
    try {
      await clearStageDrainWatermarks(stageId);
    } catch (error) {
      log.warn(`Failed to clear PBL drain watermarks for stage ${stageId}:`, error);
    }

    log.info(`Deleted stage: ${stageId}`);
    await runtimeDeletion.settlement;
  } catch (error) {
    if (!courseDeleted) {
      unmarkStageDeleted(stageId);
      restorePendingStageChanges(stageId, discardedChanges);
    }
    log.error('Failed to delete stage:', error);
    throw error;
  } finally {
    settleStageDeletionCascade(stageId);
  }

  if (isStageDeleted(stageId)) clearStoreForDeletedStage(stageId);
}

/**
 * List all stages (single PostgREST query with a scene(count) aggregate; never throws).
 */
export async function listStages(): Promise<StageListItem[]> {
  return listCourses();
}

type ThumbnailMediaElement = {
  type: string;
  src?: string;
  mediaRef?: string;
  poster?: string;
};

type ThumbnailSlide = import('@openmaic/dsl').Slide;

function revokeObjectUrl(url: string | undefined) {
  if (url?.startsWith('blob:')) {
    URL.revokeObjectURL(url);
  }
}

export function revokeThumbnailSlideMediaUrls(slides: Record<string, ThumbnailSlide>) {
  for (const slide of Object.values(slides)) {
    for (const element of slide.elements as ThumbnailMediaElement[]) {
      if (element.type === 'image' || element.type === 'video') {
        revokeObjectUrl(element.src);
      }
      if (element.type === 'video') {
        revokeObjectUrl(element.poster);
      }
    }
  }
}

/**
 * Get first slide scene's canvas data for each stage (for thumbnail preview).
 * Delegates to the Supabase data-access layer: media refs resolve through
 * `oss_key`, which is stored as the full public CDN URL, so the resolver is
 * identity (no blob fetch, no URL.createObjectURL).
 */
export async function getFirstSlideByStages(
  stageIds: string[],
): Promise<Record<string, ThumbnailSlide>> {
  return getFirstSlideByStagesFromQueries(stageIds, async (ossKey) => ossKey ?? undefined);
}

/**
 * Rename a stage (guarded course UPDATE; captures the new guard for the next write).
 */
export async function renameStage(stageId: string, newName: string): Promise<void> {
  try {
    const newGuard = await renameCourse(stageId, newName, guardByStageId.get(stageId));
    guardByStageId.set(stageId, newGuard);
    log.info(`Renamed stage ${stageId} to "${newName}"`);
  } catch (error) {
    log.error('Failed to rename stage:', error);
    throw error;
  }
}

/**
 * Check if stage exists (never throws; returns false on error).
 */
export async function stageExists(stageId: string): Promise<boolean> {
  return courseExists(stageId);
}
