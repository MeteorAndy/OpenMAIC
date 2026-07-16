/**
 * SaaS Postgres schema (feat/saas).
 *
 * Three groups:
 *   1. Auth — better-auth tables (user / session / account / verification).
 *      Column names follow better-auth's expected adapter shape; reconcile with
 *      `npx @better-auth/cli generate` after changing auth config.
 *   2. Business — server-canonical mirrors of the core Dexie entities
 *      (course=stage, scene, chat_session, generated_agent, media_file metadata).
 *      All carry userId for multi-tenant isolation.
 *   3. Commerce — plan / subscription / usage (subscription tiers + quota).
 *
 * Media blobs are NOT stored here — they live in object storage (see lib/storage),
 * referenced by `ossKey`. JSON columns are intentionally untyped to avoid coupling
 * the schema loader to app-side types; the repository layer casts.
 */
import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ==================== 1. Auth (better-auth) ====================

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  image: text('image'),
  role: text('role').default('user').notNull(), // 'user' | 'admin'
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at').notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
});

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ==================== 2. Business (server-canonical) ====================

/** A course (= Dexie "stage"): a generated lesson/classroom. */
export const course = pgTable(
  'course',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    languageDirective: text('language_directive'),
    style: text('style'),
    currentSceneId: text('current_scene_id'),
    agentIds: text('agent_ids').array(),
    videoManifest: jsonb('video_manifest'),
    interactiveMode: boolean('interactive_mode').default(false),
    taskEngineMode: boolean('task_engine_mode').default(false),
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
    courseId: text('course_id')
      .notNull()
      .references(() => course.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
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
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    courseId: text('course_id').references(() => course.id, { onDelete: 'cascade' }),
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
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  courseId: text('course_id')
    .notNull()
    .references(() => course.id, { onDelete: 'cascade' }),
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
    // Compound key `${courseId}:${elementId}` mirrors Dexie to stay globally unique.
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    courseId: text('course_id')
      .notNull()
      .references(() => course.id, { onDelete: 'cascade' }),
    type: text('type').notNull(), // 'image' | 'video'
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

// ==================== 3. Commerce (subscription tiers + quota) ====================

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
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    planId: text('plan_id')
      .notNull()
      .references(() => plan.id),
    status: text('status').notNull(), // 'active' | 'trialing' | 'canceled' | 'past_due'
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
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
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
