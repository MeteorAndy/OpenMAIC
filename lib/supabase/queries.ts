/**
 * Supabase data-access layer (Stage C1) — additive, build-verifiable.
 *
 * Browser-only flat module of functions over the existing browser client
 * (`createClient()` from `@/lib/supabase/client`). RLS (`db/rls.sql`,
 * `user_id = auth.uid()`) is the isolation boundary, so this layer is
 * automatically user-scoped and NEVER adds a `user_id` WHERE filter on reads.
 * `user_id` is injected on every write (RLS `WITH CHECK` rejects rows missing
 * it) via the cached {@link currentUserId}.
 *
 * supabase-js/PostgREST returns raw snake_case columns; each function maps
 * snake_case <-> camelCase app objects at the boundary via small inline
 * mappers. No repository class, no interface-for-one-impl — functions in a
 * file.
 *
 * Timestamps are the drop-in hazard: Dexie stores epoch-ms everywhere, Drizzle
 * stores Postgres timestamps. {@link ts2ms} / {@link ms2iso} convert at every
 * read/write. The optimistic-concurrency GUARD is the ONE value that must never
 * be ms-round-tripped: it is stored and echoed as the exact ISO string the
 * server returned (PG timestamps carry microsecond precision; a ms round-trip
 * would make `.eq('updated_at', guard)` silently fail to match). The guard
 * type is therefore `string`, kept opaque outside this module.
 *
 * C1 scope: this module only. No existing Dexie call-site is rewired, Dexie is
 * not deleted. The return shapes mirror `lib/utils/stage-storage.ts` +
 * `lib/utils/chat-storage.ts` + `lib/utils/database.ts` field-for-field so a
 * later rewire (C2-C5) is a mechanical swap.
 *
 * Server prerequisites (block C2, not this file): a `set_updated_at()` BEFORE
 * UPDATE trigger on course/scene/chat_session (otherwise the guard never
 * advances and the lock is a no-op), and `ON DELETE CASCADE` FKs from
 * scene/chat_session/generated_agent/media_file -> course(id).
 */
import { createClient } from '@/lib/supabase/client';
import { makeScene, isSlideContent } from '@/lib/types/stage';
import type {
  Stage,
  Scene,
  SceneContent,
  GeneratedAgentConfig,
  Whiteboard,
  VideoManifest,
} from '@/lib/types/stage';
import type {
  ChatSession,
  ChatMessageMetadata,
  SessionStatus,
  SessionConfig,
  ToolCallRecord,
} from '@/lib/types/chat';
import type { UIMessage } from 'ai';
import type { SceneOutline } from '@/lib/types/generation';
import type { VoiceDesign } from '@/lib/audio/voice-design';
import type { Slide } from '@openmaic/dsl';
// Type-only: no runtime coupling to Dexie. These are plain persisted-shape
// interfaces reused so the drop-in contract is exact.
import type {
  SceneRecord,
  GeneratedAgentRecord,
} from '@/lib/utils/database';
import type { StageListItem } from '@/lib/utils/stage-storage';
import { createLogger } from '@/lib/logger';

const log = createLogger('SupabaseQueries');

// One browser client per tab; the session JWT lives inside it, so
// currentUserId() is one getUser() per tab, not per write.
const supabase = createClient();

// ==================== Errors ====================

/** Thrown when a guarded course write matched 0 rows (stale `updated_at` guard). */
export class ConcurrencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrencyConflictError';
  }
}

// ==================== Boundary helpers ====================

let cachedUserId: string | null = null;

/** The current auth user's id. Resolved once per tab and cached. Injected on every write. */
export async function currentUserId(): Promise<string> {
  if (cachedUserId) return cachedUserId;
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    throw new Error(
      `currentUserId: not authenticated (${error?.message ?? 'no session'})`,
    );
  }
  cachedUserId = data.user.id;
  return cachedUserId;
}

/** Postgres timestamp (ISO) -> epoch-ms (Dexie's universal currency). */
function ts2ms(iso: string): number {
  // ponytail: columns are NOT NULL defaultNow(), so iso is always present;
  // no null-guard needed. If a future nullable timestamp appears, add it here.
  return new Date(iso).getTime();
}

/** epoch-ms -> Postgres timestamp (ISO) for writes. */
function ms2iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Recursively coerce a value to JSON-serializable form for jsonb columns.
 * Postgres jsonb cannot represent undefined / Date / Map / Set / functions,
 * while Dexie used structured clone (which does). Apply at every jsonb
 * boundary to avoid silent shape drift:
 *   - undefined values (and their keys) are dropped,
 *   - Date -> ISO string (accepted one-way drift; noted in C1 risks),
 *   - Map / Set / function / bigint throw (catches fidelity bugs early).
 *
 * This is the jsonb trust boundary — not simplified away.
 */
function sanitizeForJsonb<T>(value: T): T | null {
  if (value === null || value === undefined) return null;
  const v = value as unknown;
  if (typeof v === 'function') {
    throw new Error('sanitizeForJsonb: function is not jsonb-serializable');
  }
  if (typeof v === 'bigint') {
    throw new Error('sanitizeForJsonb: bigint is not jsonb-serializable');
  }
  if (v instanceof Date) return v.toISOString() as unknown as T;
  if (v instanceof Map || v instanceof Set) {
    throw new Error('sanitizeForJsonb: Map/Set are not jsonb-serializable');
  }
  if (Array.isArray(v)) {
    return v.map((item) => sanitizeForJsonb(item)) as unknown as T;
  }
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      if (child === undefined) continue; // jsonb omits undefined keys
      out[k] = sanitizeForJsonb(child);
    }
    return out as unknown as T;
  }
  return value; // string | number | boolean
}

/** Best-effort JSON.parse that never throws (returns {} on bad/empty input). */
function safeJsonParse(s: string | null | undefined): Record<string, unknown> {
  if (!s) return {};
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ==================== Row types (snake_case, mirror db/schema.ts) ====================

export interface CourseRow {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  language_directive: string | null;
  style: string | null;
  current_scene_id: string | null;
  agent_ids: string[] | null;
  video_manifest: VideoManifest | null;
  interactive_mode: boolean | null;
  task_engine_mode: boolean | null;
  dsl_version: string | null;
  outline: unknown;
  created_at: string;
  updated_at: string;
}

export interface SceneRow {
  id: string;
  user_id: string;
  course_id: string;
  type: string;
  title: string;
  order: number;
  content: SceneContent;
  actions: unknown;
  whiteboard: unknown; // stored singular; mirrors Scene.whiteboards (plural)
  created_at: string;
  updated_at: string;
}

export interface ChatSessionRow {
  id: string;
  user_id: string;
  course_id: string | null;
  type: string;
  title: string;
  status: string;
  messages: unknown;
  config: unknown;
  tool_calls: unknown;
  pending_tool_calls: unknown;
  scene_id: string | null;
  last_action_index: number | null;
  created_at: string;
  updated_at: string;
}

export interface GeneratedAgentRow {
  id: string;
  user_id: string;
  course_id: string;
  name: string;
  role: string;
  persona: string;
  avatar: string;
  color: string;
  priority: number;
  voice_design: VoiceDesign | null;
  created_at: string;
}

export interface MediaFileRow {
  id: string;
  user_id: string;
  course_id: string;
  type: 'image' | 'video';
  mime_type: string;
  size: number;
  prompt: string | null;
  params: Record<string, unknown> | null; // jsonb, parsed by PostgREST
  oss_key: string | null;
  poster_oss_key: string | null;
  error: string | null;
  error_code: string | null;
  created_at: string;
  /** Derived: id.split(':').slice(1).join(':') — the element id portion. */
  element_id: string;
}

// App-facing input/output shapes =================================================

/**
 * A `Stage` superset that also carries the persisted fields the DSL `Stage`
 * type omits (`currentSceneId`, `generatedAgentConfigs`). This is the true
 * runtime shape of a Dexie `StageRecord`; {@link getCourse} returns it so the
 * loadStageData wrapper needs no casts.
 */
export type CourseStage = Stage & {
  currentSceneId?: string;
  generatedAgentConfigs?: GeneratedAgentConfig[];
};

/** Input shape for {@link replaceGeneratedAgents} (= saveGeneratedAgents param). */
export interface GeneratedAgentInput {
  id: string;
  name: string;
  role: string;
  persona: string;
  avatar: string;
  color: string;
  priority: number;
  /** Dropped — no DB column; transient provider state re-derived by warmUpAgentVoices. */
  voiceConfig?: { providerId: string; voiceId: string };
  voiceDesign?: VoiceDesign;
}

/** Input shape for {@link upsertMediaFile} (camelCase, app-friendly). */
export interface MediaFileInput {
  /** Compound key `${courseId}:${elementId}` (mediaFileKey). */
  id: string;
  courseId: string;
  type: 'image' | 'video';
  mimeType: string;
  size: number;
  prompt?: string;
  /** Generation params as an object OR a JSON string (parsed before write). */
  params?: Record<string, unknown> | string;
  ossKey?: string | null;
  posterOssKey?: string | null;
  error?: string | null;
  errorCode?: string | null;
  /** epoch-ms; defaults to now. */
  createdAt?: number;
}

/** Outline payload for {@link setCourseOutline} (app-owned jsonb, verbatim). */
export type CourseOutline = {
  outlines: SceneOutline[];
  generationComplete?: boolean;
} | null;

// ==================== snake -> camel mappers ====================

function rowToCourseStage(row: CourseRow): CourseStage {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    createdAt: ts2ms(row.created_at),
    updatedAt: ts2ms(row.updated_at),
    languageDirective: row.language_directive ?? undefined,
    style: row.style ?? undefined,
    agentIds: row.agent_ids ?? undefined,
    videoManifest: (row.video_manifest as VideoManifest | null) ?? undefined,
    interactiveMode: row.interactive_mode ?? undefined,
    taskEngineMode: row.task_engine_mode ?? undefined,
    currentSceneId: row.current_scene_id ?? undefined,
    // generatedAgentConfigs has no course column; rebuilt from generated_agent
    // rows + editor state. Explicitly absent on read.
    generatedAgentConfigs: undefined,
  };
}

function rowToSceneRecord(row: SceneRow): SceneRecord {
  return {
    id: row.id,
    stageId: row.course_id,
    type: row.type as SceneRecord['type'],
    title: row.title,
    order: row.order,
    content: row.content,
    actions: (row.actions as SceneRecord['actions']) ?? undefined,
    whiteboard: (row.whiteboard as Whiteboard[] | null) ?? undefined,
    createdAt: ts2ms(row.created_at),
    updatedAt: ts2ms(row.updated_at),
  };
}

function rowToScene(row: SceneRow): Scene {
  // Dexie persists whiteboards under the Scene's plural field (a stray key on
  // the record); the DB `whiteboard` (singular) column carries it. Restore onto
  // the core's plural field before makeScene binds the discriminant. The jsonb
  // is shape-agnostic; cast to the declared Scene.whiteboards type (Slide[]).
  const record = rowToSceneRecord(row);
  return makeScene(
    {
      ...record,
      whiteboards: (row.whiteboard as Slide[] | null) ?? undefined,
    },
    row.content,
  );
}

// ==================== Optimistic-concurrency internals ====================

/**
 * Run a guarded course UPDATE. Appends `.eq('updated_at', guard)` only when a
 * guard is supplied (undefined = unguarded first-write, matching Dexie
 * last-write-wins). Returns the NEW server `updated_at` (the next guard), or
 * throws {@link ConcurrencyConflictError} when 0 rows matched.
 */
async function guardedCourseUpdate(
  courseId: string,
  patch: Record<string, unknown>,
  guard: string | undefined,
): Promise<string> {
  let query = supabase.from('course').update(patch).eq('id', courseId);
  if (guard !== undefined) query = query.eq('updated_at', guard);
  const { data, error } = await query.select('updated_at').maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new ConcurrencyConflictError(
      `guardedCourseUpdate: course ${courseId} not found or guard stale`,
    );
  }
  return data.updated_at as string;
}

// ==================== Public: course (= stage) ====================

/** Drop-in for listStages(). Uses scene(count) aggregate to avoid the Dexie N+1. Never throws. */
export async function listCourses(): Promise<StageListItem[]> {
  try {
    const { data, error } = await supabase
      .from('course')
      .select(
        'id,name,description,interactive_mode,task_engine_mode,created_at,updated_at,scene(count)',
      )
      .order('updated_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map((row: Record<string, unknown>) => ({
      id: row.id as string,
      name: row.name as string,
      description: (row.description as string | null) ?? undefined,
      sceneCount: Number(((row.scene as { count: number }[] | null)?.[0]?.count) ?? 0),
      createdAt: ts2ms(row.created_at as string),
      updatedAt: ts2ms(row.updated_at as string),
      interactiveMode: (row.interactive_mode as boolean | null) ?? undefined,
      taskEngineMode: (row.task_engine_mode as boolean | null) ?? undefined,
    }));
  } catch (error) {
    log.error('listCourses failed:', error);
    return []; // mirrors stage-storage.ts: never throws
  }
}

/**
 * Read half of loadStageData. guard = raw server updated_at (opaque ISO string).
 * `outline` is the app-owned course.outline jsonb ({outlines, generationComplete}
 * | null), surfaced so loadStageData / store outline writes get it + the guard in
 * ONE round trip instead of a second query (C2 plan option a).
 */
export async function getCourse(
  courseId: string,
): Promise<{ stage: CourseStage; guard: string; outline: CourseOutline } | null> {
  const { data, error } = await supabase
    .from('course')
    .select('*')
    .eq('id', courseId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    stage: rowToCourseStage(data as unknown as CourseRow),
    guard: (data.updated_at as string) ?? '',
    outline: (data.outline as CourseOutline) ?? null,
  };
}

/** Drop-in for stageExists(). Never throws (returns false on error). */
export async function courseExists(courseId: string): Promise<boolean> {
  try {
    const { data } = await supabase
      .from('course')
      .select('id')
      .eq('id', courseId)
      .maybeSingle();
    return !!data;
  } catch (error) {
    log.error('courseExists failed:', error);
    return false;
  }
}

/** Drop-in for renameStage(); returns the new guard (wrapper ignores it). */
export async function renameCourse(
  courseId: string,
  name: string,
  guard?: string,
): Promise<string> {
  return guardedCourseUpdate(courseId, { name, updated_at: ms2iso(Date.now()) }, guard);
}

/**
 * Course half of saveStageData. INSERT-or-guarded-UPDATE.
 * Returns the new server updated_at. `generatedAgentConfigs` is intentionally
 * NOT written (no course column); `outline` is owned by {@link setCourseOutline}.
 */
export async function upsertCourse(
  courseId: string,
  stage: Stage,
  currentSceneId: string | null,
  guard?: string,
): Promise<string> {
  const userId = await currentUserId();
  const nowIso = ms2iso(Date.now());
  // Stage doesn't declare dslVersion; read defensively so it round-trips once
  // the field is plumbed. Only written when present (don't clobber on update).
  const stageExtras = stage as Stage & { dslVersion?: string };

  const buildRow = (): Record<string, unknown> => {
    const row: Record<string, unknown> = {
      id: courseId,
      user_id: userId,
      name: stage.name,
      description: stage.description ?? null,
      language_directive: stage.languageDirective ?? null,
      style: stage.style ?? null,
      current_scene_id: currentSceneId ?? null,
      agent_ids: stage.agentIds ?? null,
      video_manifest: sanitizeForJsonb(stage.videoManifest),
      interactive_mode: stage.interactiveMode ?? false,
      task_engine_mode: stage.taskEngineMode ?? false,
      created_at: ms2iso(stage.createdAt ?? Date.now()),
      updated_at: nowIso,
    };
    if (stageExtras.dslVersion !== undefined) {
      row.dsl_version = stageExtras.dslVersion;
    }
    return row;
  };

  if (guard !== undefined) {
    // Guarded UPDATE only; 0 rows = stale guard.
    return guardedCourseUpdate(courseId, buildRow(), guard);
  }
  // No guard: insert-or-update (first write / caller opted out of locking).
  // ponytail: last-write-wins when unguarded — matches Dexie semantics.
  const row = buildRow();
  const { data, error } = await supabase
    .from('course')
    .upsert(row, { onConflict: 'id' })
    .select('updated_at')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`upsertCourse: no row returned for ${courseId}`);
  return data.updated_at as string;
}

/** Drop-in for the db.stages.delete half of deleteStageData (CASCADE clears children). */
export async function deleteCourse(courseId: string): Promise<void> {
  const { error } = await supabase.from('course').delete().eq('id', courseId);
  if (error) throw error;
}

// ==================== Public: scenes ====================

/**
 * Scene full-replace for saveStageData. Idempotent delete-by-courseId + upsert,
 * so a retry after partial failure converges. Guarded at the COURSE level by
 * the wrapper (runs only after upsertCourse succeeds), not row-level.
 */
export async function replaceScenes(courseId: string, scenes: Scene[]): Promise<void> {
  const userId = await currentUserId();
  const delRes = await supabase.from('scene').delete().eq('course_id', courseId);
  if (delRes.error) throw delRes.error;
  if (scenes.length === 0) return;

  const rows = scenes.map((scene, index) => ({
    id: scene.id,
    user_id: userId,
    course_id: courseId,
    type: scene.type,
    title: scene.title,
    order: scene.order ?? index,
    content: sanitizeForJsonb(scene.content),
    actions: sanitizeForJsonb(scene.actions),
    // Scene.whiteboards (plural) -> DB whiteboard (singular) column.
    whiteboard: sanitizeForJsonb(scene.whiteboards),
    created_at: ms2iso(scene.createdAt ?? Date.now()),
    updated_at: ms2iso(scene.updatedAt ?? Date.now()),
  }));
  const { error } = await supabase.from('scene').upsert(rows);
  if (error) throw error;
}

/**
 * Read half of loadStageData's scene step. `scenes` are makeScene-bound exactly
 * like stage-storage.ts:115; `raw` is the loose persisted record for callers
 * (e.g. getFirstSlideByStages) that need the pre-bind shape.
 */
export async function getScenes(
  courseId: string,
): Promise<{ scenes: Scene[]; raw: SceneRecord[] }> {
  const { data, error } = await supabase
    .from('scene')
    .select('*')
    .eq('course_id', courseId)
    .order('order', { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as unknown as SceneRow[];
  return {
    scenes: rows.map(rowToScene),
    raw: rows.map(rowToSceneRecord),
  };
}

// ==================== Public: chat sessions ====================

const MAX_CHAT_MESSAGES = 200;

/**
 * Drop-in for saveChatSessions. Reproduces the 4 invariants VERBATIM:
 *   (1) empty array => delete all,
 *   (2) status 'active' -> 'interrupted',
 *   (3) messages truncated to last 200,
 *   (4) pendingToolCalls forced to [].
 */
export async function replaceChatSessions(
  courseId: string,
  sessions: ChatSession[],
): Promise<void> {
  const userId = await currentUserId();
  const delRes = await supabase.from('chat_session').delete().eq('course_id', courseId);
  if (delRes.error) throw delRes.error;
  if (!sessions || sessions.length === 0) return; // invariant 1

  const rows = sessions.map((s) => ({
    id: s.id,
    user_id: userId,
    course_id: courseId,
    type: s.type,
    title: s.title,
    status: (s.status === 'active' ? 'interrupted' : s.status) as SessionStatus, // invariant 2
    messages: sanitizeForJsonb(s.messages.slice(-MAX_CHAT_MESSAGES)), // invariant 3
    config: sanitizeForJsonb(s.config),
    tool_calls: sanitizeForJsonb(s.toolCalls),
    pending_tool_calls: [], // invariant 4
    scene_id: s.sceneId ?? null,
    last_action_index: s.lastActionIndex ?? null,
    created_at: ms2iso(s.createdAt),
    updated_at: ms2iso(s.updatedAt),
  }));
  const { error } = await supabase.from('chat_session').upsert(rows);
  if (error) throw error;
}

/** Drop-in for loadChatSessions. Sorted createdAt ASC; pendingToolCalls always [] on read. */
export async function getChatSessions(courseId: string): Promise<ChatSession[]> {
  const { data, error } = await supabase
    .from('chat_session')
    .select('*')
    .eq('course_id', courseId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as unknown as ChatSessionRow[];
  return rows.map((r) => ({
    id: r.id,
    type: r.type as ChatSession['type'],
    title: r.title,
    status: r.status as SessionStatus,
    messages: (r.messages ?? []) as UIMessage<ChatMessageMetadata>[],
    config: (r.config as SessionConfig | null) ?? { agentIds: [] },
    toolCalls: (r.tool_calls ?? []) as ToolCallRecord[],
    pendingToolCalls: [], // cleared on save; always [] on read
    createdAt: ts2ms(r.created_at),
    updatedAt: ts2ms(r.updated_at),
    sceneId: r.scene_id ?? undefined,
    lastActionIndex: r.last_action_index ?? undefined,
  }));
}

/** Drop-in for deleteChatSessions (chat-storage.ts:79). */
export async function deleteChatSessions(courseId: string): Promise<void> {
  const { error } = await supabase.from('chat_session').delete().eq('course_id', courseId);
  if (error) throw error;
}

// ==================== Public: generated agents ====================

/**
 * Drop-in for the db.generatedAgents writes in saveGeneratedAgents. Full-replace
 * guarded by the parent course.updated_at in the wrapper (generated_agent has no
 * updated_at). voiceConfig is dropped (no column). registry.addAgent /
 * warmUpAgentVoices side-effects stay in registry/store.ts.
 */
export async function replaceGeneratedAgents(
  courseId: string,
  agents: GeneratedAgentInput[],
): Promise<void> {
  const userId = await currentUserId();
  const delRes = await supabase.from('generated_agent').delete().eq('course_id', courseId);
  if (delRes.error) throw delRes.error;
  if (agents.length === 0) return;

  const rows = agents.map((a) => ({
    id: a.id,
    user_id: userId,
    course_id: courseId,
    name: a.name,
    role: a.role,
    persona: a.persona,
    avatar: a.avatar,
    color: a.color,
    priority: a.priority,
    voice_design: sanitizeForJsonb(a.voiceDesign),
    created_at: ms2iso(Date.now()),
  }));
  const { error } = await supabase.from('generated_agent').upsert(rows);
  if (error) throw error;
}

/** Drop-in for getGeneratedAgentsByStageId (stageId repopulated = courseId). */
export async function getGeneratedAgents(
  courseId: string,
): Promise<GeneratedAgentRecord[]> {
  const { data, error } = await supabase
    .from('generated_agent')
    .select('*')
    .eq('course_id', courseId);
  if (error) throw error;
  const rows = (data ?? []) as unknown as GeneratedAgentRow[];
  return rows.map((r) => ({
    id: r.id,
    stageId: r.course_id,
    name: r.name,
    role: r.role,
    persona: r.persona,
    avatar: r.avatar,
    color: r.color,
    priority: r.priority,
    voiceDesign: r.voice_design ?? undefined,
    createdAt: ts2ms(r.created_at),
  }));
}

// ==================== Public: media_file (metadata only) ====================

/**
 * Metadata-only upsert for media-orchestrator writes. NO blob column — blobs
 * upload to object storage separately and the returned URLs become oss_key /
 * poster_oss_key. params is stored as jsonb (parsed), not a JSON string.
 */
export async function upsertMediaFile(input: MediaFileInput): Promise<void> {
  const userId = await currentUserId();
  const paramsObj =
    typeof input.params === 'string' ? safeJsonParse(input.params) : (input.params ?? {});

  const row = {
    id: input.id,
    user_id: userId,
    course_id: input.courseId,
    type: input.type,
    mime_type: input.mimeType,
    size: input.size,
    prompt: input.prompt ?? null,
    params: sanitizeForJsonb(paramsObj),
    oss_key: input.ossKey ?? null,
    poster_oss_key: input.posterOssKey ?? null,
    error: input.error ?? null,
    error_code: input.errorCode ?? null,
    created_at: ms2iso(input.createdAt ?? Date.now()),
  };
  const { error } = await supabase.from('media_file').upsert(row);
  if (error) throw error;
}

/** Drop-in for retryMediaTask's db.mediaFiles.delete. id = mediaFileKey(stageId,elementId). */
// ponytail: object-storage (oss_key) cleanup is best-effort and lands with the
// C4 blob move; today's Dexie path also deletes only the row. DB-only here.
export async function deleteMediaFile(id: string): Promise<void> {
  const { error } = await supabase.from('media_file').delete().eq('id', id);
  if (error) throw error;
}

/**
 * Metadata list for restoreFromDB + getFirstSlideByStages + export. Returns rows
 * with elementId split from the compound id. NO blob — fetched via oss_key in C4.
 */
export async function getMediaFiles(courseId: string): Promise<MediaFileRow[]> {
  const { data, error } = await supabase
    .from('media_file')
    .select('*')
    .eq('course_id', courseId);
  if (error) throw error;
  const rows = (data ?? []) as unknown as Omit<MediaFileRow, 'element_id'>[];
  return rows.map((r) => ({
    ...r,
    element_id: r.id.includes(':') ? r.id.split(':').slice(1).join(':') : r.id,
  }));
}

// ==================== Public: outline ====================

/**
 * Replaces the 4 db.stageOutlines sites in lib/store/stage.ts. outline is
 * app-owned jsonb persisted verbatim. Throws ConcurrencyConflictError on 0 rows;
 * the store's debouncedSave coalesces retries. The self-heal read-modify-write
 * (stage.ts:458-469) MUST run inside one guarded update — wrapper does getCourse
 * to read current outline/guard, merges generationComplete, then calls this.
 */
export async function setCourseOutline(
  courseId: string,
  outline: CourseOutline,
  guard?: string,
): Promise<string> {
  return guardedCourseUpdate(
    courseId,
    { outline: sanitizeForJsonb(outline), updated_at: ms2iso(Date.now()) },
    guard,
  );
}

// ==================== Public: thumbnails (getFirstSlideByStages) ====================

type ThumbnailSlide = Slide;

type ThumbnailMediaElement = {
  type: string;
  src?: string;
  mediaRef?: string;
  poster?: string;
};

/**
 * Resolves a media element's oss_key (or poster oss_key) to a playable object
 * URL. C2/C3 wrapper reads the Dexie blob cache; C4 fetches bytes by oss_key.
 * Return undefined to leave the element as an unresolved placeholder.
 */
export type ThumbnailMediaResolver = (
  ossKey: string | null | undefined,
) => Promise<string | undefined>;

// ponytail: these three helpers + getThumbnailMediaRef / getMediaRecordElementId
// are copied verbatim from stage-storage.ts. They get consolidated when C2
// rewires stage-storage.getFirstSlideByStages to delegate here (the duplicates
// there are deleted at that point). Kept local so this layer has no runtime
// dependency on the Dexie-importing stage-storage module.
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

/**
 * First-slide thumbnail per course (mirrors stage-storage.ts:258). Only the blob
 * source changes versus Dexie: media refs are resolved through `mediaResolver`
 * (oss_key -> object URL), so this layer never touches Dexie directly. The
 * mediaRef->record matching logic (exact + legacy sequential-video fallback) is
 * preserved verbatim.
 */
export async function getFirstSlideByStages(
  courseIds: string[],
  mediaResolver: ThumbnailMediaResolver,
): Promise<Record<string, ThumbnailSlide>> {
  const result: Record<string, ThumbnailSlide> = {};
  try {
    await Promise.all(
      courseIds.map(async (courseId) => {
        const { scenes } = await getScenes(courseId);
        const firstSlide = scenes.find((s) => isSlideContent(s.content));
        if (!firstSlide || !isSlideContent(firstSlide.content)) return;

        const slide = structuredClone(firstSlide.content.canvas) as ThumbnailSlide;
        const mediaElements = (slide.elements as ThumbnailMediaElement[]).filter((el) =>
          getThumbnailMediaRef(el),
        );

        if (mediaElements.length > 0) {
          const mediaRows = await getMediaFiles(courseId);
          const videoRows = mediaRows.filter((r) => !r.error && r.type === 'video');
          const mediaMap = new Map(
            mediaRows.map((r) => [getMediaRecordElementId(r.id), r] as const),
          );

          for (const el of mediaElements) {
            const mediaRef = getThumbnailMediaRef(el);
            const exactRecord = mediaRef ? mediaMap.get(mediaRef) : undefined;
            const usableExactRecord =
              exactRecord && !exactRecord.error ? exactRecord : undefined;
            const legacyRecord =
              !exactRecord &&
              el.type === 'video' &&
              isLegacySequentialVideoRef(mediaRef) &&
              videoRows.length === 1
                ? videoRows[0]
                : undefined;
            const record = usableExactRecord ?? legacyRecord;

            if (!mediaRef || !record) {
              if (el.type === 'image') {
                // Clear unresolved placeholder so BaseImageElement won't subscribe
                // to the global media store (stale data from another course).
                el.src = '';
              }
              continue;
            }

            if (el.type === 'image' && record.type === 'image') {
              el.src = (await mediaResolver(record.oss_key)) ?? '';
            } else if (el.type === 'video' && record.type === 'video') {
              el.src = (await mediaResolver(record.oss_key)) ?? '';
              if (record.poster_oss_key) {
                el.poster = await mediaResolver(record.poster_oss_key);
              }
            } else if (el.type === 'image') {
              el.src = '';
            }
          }
        }

        result[courseId] = slide;
      }),
    );
  } catch (error) {
    log.error('getFirstSlideByStages failed:', error);
  }
  return result;
}
