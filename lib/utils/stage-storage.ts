/**
 * Stage Storage Manager
 *
 * Manages multiple stage data in IndexedDB
 * Each stage has its own storage key based on stageId
 */

import { Stage, Scene } from '../types/stage';
import { isSlideContent } from '../types/stage';
import { ChatSession } from '../types/chat';
import { db } from './database';
import { saveChatSessions, loadChatSessions, deleteChatSessions } from './chat-storage';
import {
  upsertCourse,
  getCourse,
  replaceScenes,
  getScenes,
  listCourses,
  renameCourse,
  courseExists,
  deleteCourse,
  type CourseOutline,
} from '@/lib/supabase/queries';
import { clearPlaybackState } from './playback-storage';
import { clearAllForScene } from '@/lib/quiz/persistence';
import { deleteStageRuntimeSafely } from '@/lib/runtime/store';
import { clearStageDrainWatermarks } from '@/lib/pbl/v2/runtime/drain';
import { createLogger } from '@/lib/logger';

const log = createLogger('StageStorage');

// ponytail: module-level optimistic-lock guard. Keyed by stageId, holds the raw
// server `updated_at` (opaque ISO) returned by the last course read/write.
// Threaded through saveStageData/loadStageData/renameStage so upsertCourse's
// guarded UPDATE can detect a stale write. undefined => unguarded (last-write-
// wins, byte-identical to Dexie). A separate getCourse RMW is used for outline
// writes (store/stage.ts) since those don't flow through here.
const guardByStageId = new Map<string, string>();

export interface StageStoreData {
  stage: Stage;
  scenes: Scene[];
  currentSceneId: string | null;
  chats: ChatSession[];
  /**
   * course.outline jsonb ({outlines, generationComplete} | null) — single source
   * with the course row. Load-only: populated by loadStageData (for the store's
   * resume-on-mount read); saveStageData does NOT write it (outline is owned by
   * setCourseOutline), so it's optional here.
   */
  outline?: CourseOutline;
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

/**
 * Save stage data to Supabase (course + scenes + chats move together).
 */
export async function saveStageData(stageId: string, data: StageStoreData): Promise<void> {
  try {
    const guard = guardByStageId.get(stageId);
    const newGuard = await upsertCourse(stageId, data.stage, data.currentSceneId || null, guard);
    guardByStageId.set(stageId, newGuard);

    // Scenes full-replace (delete-by-course + upsert). Guarded at the course
    // level by the upsertCourse above succeeding first.
    await replaceScenes(stageId, data.scenes);

    // Chat sessions persist through the now-delegated chat-storage (Supabase).
    if (data.chats) {
      await saveChatSessions(stageId, data.chats);
    }

    log.info(`Saved stage: ${stageId}`);
  } catch (error) {
    log.error('Failed to save stage:', error);
    throw error;
  }
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
    const chats = await loadChatSessions(stageId);

    log.info(`Loaded stage: ${stageId}, scenes: ${scenes.length}, chats: ${chats.length}`);

    return {
      stage,
      scenes,
      // currentSceneId fallback chain preserved verbatim.
      currentSceneId: stage.currentSceneId || scenes[0]?.id || null,
      chats,
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
export async function deleteStageData(stageId: string): Promise<void> {
  try {
    // Collect scene ids before the DB delete (PostgREST read; returns [] if absent).
    const { raw } = await getScenes(stageId);
    const sceneIds = raw.map((s) => s.id);

    // deleteCourse CASCADE-clears DB scene/chat_session/generated_agent/media_file
    // rows (db/c2_prereqs.sql). Device-local cleanup follows.
    await deleteCourse(stageId);

    // Redundant with CASCADE but harmless (idempotent); keeps the chat-storage
    // contract for environments where the FK isn't applied yet.
    await deleteChatSessions(stageId);
    await clearPlaybackState(stageId);

    // Sweep quiz persistence keys for each deleted scene.
    for (const sceneId of sceneIds) {
      clearAllForScene(sceneId);
    }

    // Learner-runtime data lives in a separate IndexedDB database, so it is
    // cascaded after the Supabase work: it cannot join those calls, and a
    // runtime failure must not abort them (the helper warns instead of
    // throwing).
    await deleteStageRuntimeSafely(stageId);
    try {
      await clearStageDrainWatermarks(stageId);
    } catch (error) {
      log.warn(`Failed to clear PBL drain watermarks for stage ${stageId}:`, error);
    }

    log.info(`Deleted stage: ${stageId}`);
  } catch (error) {
    log.error('Failed to delete stage:', error);
    throw error;
  }
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

function isGeneratedMediaRef(value: unknown): value is string {
  return typeof value === 'string' && /^gen_(img|vid)_[\w-]+$/i.test(value);
}

function isLegacySequentialVideoRef(value: unknown): value is string {
  return typeof value === 'string' && /^gen_vid_\d+$/i.test(value);
}

function getThumbnailMediaRef(element: ThumbnailMediaElement): string | undefined {
  if (element.type === 'image' && isGeneratedMediaRef(element.src)) {
    return element.src;
  }
  if (element.type === 'video') {
    if (isGeneratedMediaRef(element.mediaRef)) return element.mediaRef;
    if (isGeneratedMediaRef(element.src)) return element.src;
  }
  return undefined;
}

function getMediaRecordElementId(recordId: string): string {
  return recordId.includes(':') ? recordId.split(':').slice(1).join(':') : recordId;
}

function blobWithType(blob: Blob, mimeType: string): Blob {
  return blob.type ? blob : new Blob([blob], { type: mimeType });
}

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
 * Also resolves generated image/video refs from mediaFiles so thumbnails show real media.
 * Returns a map of stageId -> Slide (canvas data with resolved media)
 */
export async function getFirstSlideByStages(
  stageIds: string[],
): Promise<Record<string, ThumbnailSlide>> {
  const result: Record<string, ThumbnailSlide> = {};
  try {
    await Promise.all(
      stageIds.map(async (stageId) => {
        // INTENTIONAL SPLIT-READ (the one allowed): scenes from Supabase,
        // media blobs from Dexie (media stays on Dexie through Stage C4). Do
        // NOT delegate to queries.getFirstSlideByStages — that resolves via
        // oss_key against Supabase media_file, the wrong source while media
        // lives in Dexie.
        const { scenes } = await getScenes(stageId);
        const firstSlide = scenes.find((s) => isSlideContent(s.content));
        if (firstSlide && isSlideContent(firstSlide.content)) {
          const slide = structuredClone(firstSlide.content.canvas);

          const mediaElements = slide.elements.filter((el) =>
            getThumbnailMediaRef(el as ThumbnailMediaElement),
          );
          if (mediaElements.length > 0) {
            const mediaRecords = await db.mediaFiles.where('stageId').equals(stageId).toArray();
            const videoRecords = mediaRecords.filter(
              (record) => !record.error && record.type === 'video',
            );
            const mediaMap = new Map(
              mediaRecords.map((record) => [getMediaRecordElementId(record.id), record] as const),
            );

            for (const el of mediaElements as ThumbnailMediaElement[]) {
              const mediaRef = getThumbnailMediaRef(el);
              const exactRecord = mediaRef ? mediaMap.get(mediaRef) : undefined;
              const usableExactRecord = exactRecord && !exactRecord.error ? exactRecord : undefined;
              const legacyRecord =
                !exactRecord &&
                el.type === 'video' &&
                isLegacySequentialVideoRef(mediaRef) &&
                videoRecords.length === 1
                  ? videoRecords[0]
                  : undefined;
              const record = usableExactRecord ?? legacyRecord;

              if (!mediaRef || !record) {
                if (el.type === 'image') {
                  // Clear unresolved placeholder so BaseImageElement won't subscribe
                  // to the global media store (which may have stale data from another course)
                  el.src = '';
                }
                continue;
              }

              if (el.type === 'image' && record.type === 'image') {
                el.src = URL.createObjectURL(blobWithType(record.blob, record.mimeType));
              } else if (el.type === 'video' && record.type === 'video') {
                el.src = URL.createObjectURL(blobWithType(record.blob, record.mimeType));
                if (record.poster) {
                  el.poster = URL.createObjectURL(blobWithType(record.poster, 'image/jpeg'));
                }
              } else if (el.type === 'image') {
                el.src = '';
              }
            }
          }

          result[stageId] = slide;
        }
      }),
    );
  } catch (error) {
    log.error('Failed to load thumbnails:', error);
  }
  return result;
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
