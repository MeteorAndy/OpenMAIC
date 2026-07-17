/**
 * SaaS Postgres schema (feat/saas) — multi-user on self-hosted Supabase.
 *
 * Supabase owns the `auth` schema (auth.users etc. via GoTrue), so this file no
 * longer defines user/session/account/verification. Business + commerce tables
 * carry `userId` (text, matching auth.users.id); isolation is enforced by RLS
 * policies (db/rls.sql: auth.uid() = user_id) PLUS app-layer scoping. The server
 * may use the service-role key (bypassing RLS) and MUST still scope by userId.
 *
 * Groups:
 *   1. Business — server-canonical mirrors of the core entities (course=stage,
 *      scene, chat_session, generated_agent, media_file metadata). All userId-scoped.
 *   2. Commerce — plan / subscription / usage (subscription tiers + quota).
 *
 * Media blobs are NOT stored here — object storage (Supabase Storage / S3),
 * referenced by `ossKey`. JSON columns intentionally untyped; repo layer casts.
 */
import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  uuid,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ==================== 1. Business (server-canonical) ====================

/** A course (= Dexie "stage"): a generated lesson/classroom. */
export const course = pgTable(
  'course',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id').notNull(), // auth.users.id (RLS-enforced)
    name: text('name').notNull(),
    description: text('description'),
    languageDirective: text('language_directive'),
    style: text('style'),
    currentSceneId: text('current_scene_id'),
    agentIds: text('agent_ids').array(),
    videoManifest: jsonb('video_manifest'),
    interactiveMode: boolean('interactive_mode').default(false),
    taskEngineMode: boolean('task_engine_mode').default(false),
    /** DSL document version stamp (migrate-on-read). */
    dslVersion: text('dsl_version'),
    /** App-owned outline snapshot, persisted verbatim (not migrated). */
    outline: jsonb('outline'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    courseUserIdx: index('course_user_idx').on(t.userId, t.updatedAt),
  }),
);

/** A scene/page within a course (= Dexie "scene"). */
export const scene = pgTable(
  'scene',
  {
    id: text('id').primaryKey(),
    courseId: text('course_id').notNull(),
    userId: uuid('user_id').notNull(),
    type: text('type').notNull(),
    title: text('title').notNull(),
    order: integer('order').notNull(),
    content: jsonb('content'),
    actions: jsonb('actions'),
    whiteboard: jsonb('whiteboard'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    sceneCourseIdx: index('scene_course_idx').on(t.courseId, t.order),
  }),
);

/** A chat session (classroom discussion / PBL) (= Dexie "chatSession"). */
export const chatSession = pgTable(
  'chat_session',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    courseId: text('course_id'),
    type: text('type').notNull(),
    title: text('title').notNull(),
    status: text('status').notNull(),
    messages: jsonb('messages'),
    config: jsonb('config'),
    toolCalls: jsonb('tool_calls'),
    pendingToolCalls: jsonb('pending_tool_calls'),
    sceneId: text('scene_id'),
    lastActionIndex: integer('last_action_index'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    chatCourseIdx: index('chat_session_course_idx').on(t.courseId, t.createdAt),
  }),
);

/** AI-generated agent profile (= Dexie "generatedAgent"). */
export const generatedAgent = pgTable('generated_agent', {
  id: text('id').primaryKey(),
  userId: uuid('user_id').notNull(),
  courseId: text('course_id').notNull(),
  name: text('name').notNull(),
  role: text('role').notNull(),
  persona: text('persona').notNull(),
  avatar: text('avatar').notNull(),
  color: text('color').notNull(),
  priority: integer('priority').notNull(),
  voiceDesign: jsonb('voice_design'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/** AI-generated media metadata (= Dexie "mediaFile"); the blob lives in object storage. */
export const mediaFile = pgTable(
  'media_file',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    courseId: text('course_id').notNull(),
    type: text('type').notNull(),
    mimeType: text('mime_type').notNull(),
    size: integer('size').notNull(),
    prompt: text('prompt'),
    params: jsonb('params'),
    ossKey: text('oss_key'),
    posterOssKey: text('poster_oss_key'),
    error: text('error'),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    mediaCourseIdx: index('media_course_idx').on(t.courseId, t.type),
  }),
);

// ==================== 2. Commerce (subscription tiers + quota) ====================

/** A subscription plan. id is a slug: 'free' | 'pro' | 'team'. null caps = unlimited. */
export const plan = pgTable('plan', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  priceMonthlyCents: integer('price_monthly_cents').default(0).notNull(),
  maxGenerationsPerPeriod: integer('max_generations_per_period'),
  maxTokensPerPeriod: integer('max_tokens_per_period'),
  maxMediaSecondsPerPeriod: integer('max_media_seconds_per_period'),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/** A user's current subscription. One active row per user. */
export const subscription = pgTable(
  'subscription',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    planId: text('plan_id').notNull(),
    status: text('status').notNull(),
    currentPeriodStart: timestamp('current_period_start').notNull(),
    currentPeriodEnd: timestamp('current_period_end').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    subUserIdx: uniqueIndex('subscription_user_idx').on(t.userId),
  }),
);

/** Aggregated usage per user per billing period, for fast quota checks. */
export const usage = pgTable(
  'usage',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    periodStart: timestamp('period_start').notNull(),
    generations: integer('generations').default(0).notNull(),
    inputTokens: integer('input_tokens').default(0).notNull(),
    outputTokens: integer('output_tokens').default(0).notNull(),
    mediaSeconds: integer('media_seconds').default(0).notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    usagePeriodIdx: uniqueIndex('usage_user_period_idx').on(t.userId, t.periodStart),
  }),
);
