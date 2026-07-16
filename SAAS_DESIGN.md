# OpenMAIC SaaS Foundation — Design Spec

- **Date:** 2026-07-16
- **Branch:** `feat/saas` (off `main` @ `40b3b55`)
- **Status:** Approved-by-directive (user selected all recommended options via `/goal`)
- **Scope:** SaaS foundation skeleton — shippable, commercializable spine; billing/email/admin deferred behind interfaces.

## 1. Context

OpenMAIC is an AI multi-agent interactive classroom (lesson/slide/quiz/simulation/PBL
generation with TTS, whiteboard, export). Current state on `main`:

- Next.js 16 + React 19 monorepo. App at repo root; packages under `packages/`.
- **Auth:** none. A single shared `ACCESS_CODE` env + HMAC cookie enforced by
  `middleware.ts`. No user accounts.
- **Data:** Dexie/IndexedDB, **client-only**, fixed DB `MAIC-Database`. Entities:
  stages, scenes, audioFiles, imageFiles, chatSessions, playbackState, stageOutlines,
  mediaFiles, generatedAgents, voiceProfiles, autoVoiceCache, snapshots.
- **Generation:** ~36 server routes under `app/api/**`. Provider keys resolved
  server-side via `lib/server/provider-config.ts` (env + `server-providers.yml`) —
  **platform-hosted keys**.
- **Metering already present:** `lib/server/usage-storage.ts` records per-generation
  usage (llm/image/video/tts/asr + tokens/quantity) to `data/usage/*.jsonl` — but
  anonymous (no userId) and fire-and-forget, no quota.
- **Storage seams already present:** `ossKey` fields on media/audio records;
  `lib/storage/{types.ts,providers/noop.ts,index.ts}` (StorageProvider interface).
- **License:** MIT (upstream THU-MAIC + MeteorAndy). Only `mathml2omml` is LGPL,
  isolated as replaceable files. **No commercialization blocker.**

**Gaps for SaaS:** user accounts/auth; multi-tenant server-canonical storage; per-user
usage metering + quota; billing hook; containerized cloud deploy.

## 2. Decisions (recorded from user)

| Decision | Choice |
|---|---|
| Scope | **SaaS foundation skeleton** — auth + multi-tenant server store + metering + deploy; billing stubbed |
| Monetization | **Subscription tiers** — Free / Pro / Team, monthly, each with included quota |
| Data architecture | **Server-canonical + client cache** — Postgres by `userId`; client caches |
| LLM key model | **Platform-hosted keys** — operator pays; meter + limit users |

## 3. Architecture approach

**Approach A (chosen): server data layer + client as cache.** Postgres mirrors the
core entities behind REST endpoints; client persistence (Dexie today) becomes
write-through-to-server + local read cache. Reuses the existing `lib/storage` seam.

Rejected: B (Dexie-primary + background sync — dual-source-of-truth/conflict monster),
C (big-bang drop IndexedDB — too large a blast radius for a skeleton).

## 4. Tech stack

| Layer | Pick | Why |
|---|---|---|
| Auth | `better-auth` | Drizzle-native, plugin model, data in own Postgres, no paid vendor |
| DB | PostgreSQL 16 | |
| ORM | `drizzle-orm` + `drizzle-kit` | light, SQL-first, serverless-friendly |
| Object storage | extend `lib/storage` + S3-compatible provider; MinIO/local in dev | blobs out of Postgres |
| Metering | reuse `lib/server/usage-storage.ts` (+ userId) + new quota gate | injects at existing routes |
| Billing | `lib/server/billing.ts` interface + **stub** provider (Stripe later) | non-blocking seam |
| Email | `lib/server/email.ts` interface + **stub** (Resend later) | non-blocking seam |
| Rate limit | better-auth rate-limit + per-user quota as hard limit on generation | sufficient for skeleton |

## 5. Data model (server-canonical, Postgres via Drizzle)

All business/commerce tables carry `userId` (FK → user).

**better-auth tables:** `user`, `account`, `session`, `verification`.

**Business (mirror of Dexie canonical entities):**
`course` (=stage) · `scene` · `chat_session` · `generated_agent` · `media_file` (metadata only).
JSON columns hold nested content (scene `content`/`actions`/`whiteboard`, chat `messages`/`config`).

**Commerce:** `plan` (Free/Pro/Team + quota caps) · `subscription` (user → plan, period, status) ·
`usage` (per user per period: generations, tokens, media-seconds).

**Media blobs** do NOT enter Postgres — stored in object storage, referenced by the
existing `ossKey` field.

**Stay client-local (device UX state, intentionally not server-canonical):**
`playbackState`, `voiceProfiles`, `autoVoiceCache`, `snapshots`, `stageOutlines` cache.

## 6. Auth

- better-auth against the Drizzle adapter + Postgres.
- Providers: credentials (email + password) + Google + GitHub OAuth.
- `middleware.ts`: replace shared-`ACCESS_CODE` gating with better-auth session
  verification; gate all `/api/**` (except auth/health) and app pages; redirect
  unauthenticated → `/login`. `ACCESS_CODE` retained as optional dev-only fallback.

## 7. Client repo + cache

New `lib/client/repo` replaces direct `db.*()` Dexie calls **for server-canonical
entities only**: writes → server REST, Dexie = read cache + offline fallback. Core
flows wired first (course create/list/open/delete, save scenes/chat). Device-local
entities keep using Dexie directly.

## 8. Metering + quota (subscription tiers)

- `plan` rows: Free / Pro / Team with per-period caps (generation count, token total,
  media-seconds).
- Reuse existing `recordUsage`/`recordGenerationUsage` — add `userId`. Add a quota gate
  that aggregates current-period usage per user and rejects (402/429) when over plan cap,
  before running a generate handler.
- `subscription` set manually / via test stub for skeleton; Stripe webhook writes it later.

## 9. Object storage

- S3-compatible provider in `lib/storage/providers/`; dev = MinIO (compose), prod = any S3/R2.
- `upload/exists/getUrl/batchExists` keyed by hash; media generation stores `ossKey`.

## 10. Deployment

- `docker-compose.yml`: `postgres:16` + `minio` (dev).
- `Dockerfile`: Next.js standalone (already supported) — multi-tenant web service; Tauri
  shell not invoked on this branch.
- New env: `AUTH_SECRET`, `DATABASE_URL`, `S3_*` / MinIO creds. Existing provider keys unchanged.

## 11. Phased implementation plan

1. **Foundation:** deps, `docker-compose.yml`, Drizzle config + schema (auth + business + commerce), migration.
2. **Auth:** better-auth setup, `auth.ts`, middleware rewrite, login/signup UI, session gating.
3. **Server data layer:** repository + `app/api/courses|scenes|chat-sessions|...` REST, `userId` scoping.
4. **Client repo + cache:** rewire core Dexie writes to server, Dexie-as-cache.
5. **Metering:** add userId to usage records, aggregate, `plan`/`subscription` seed, quota gate on generate routes.
6. **Object storage:** S3 provider + MinIO, wire media `ossKey`.
7. **Deploy:** `Dockerfile`, compose prod profile, env docs.
8. **Verify:** typecheck, build, key tests; commit per phase.

## 12. Out of scope (deferred, interface left)

Stripe live integration; real email sending; admin dashboard; Landing/pricing pages
(placeholders only); team/org multi-seat; fine-grained rate-limit tuning; full sync
conflict resolution (last-write-wins for now); migration of existing desktop local
data (SaaS branch starts server-fresh).

## 13. License

MIT permits commercial SaaS deployment — no change required. NOTICE gets a one-line
note describing the commercial hosted-service form. `mathml2omml` LGPL handling unchanged.

## 14. Status (as built on feat/saas)

Shipped:
- **Phase 1** DB foundation — Drizzle schema (auth + business + commerce), `db/client`,
  migrations, `docker-compose.yml` (postgres + minio + opt-in app).
- **Phase 2** Auth — better-auth (email/password + optional OAuth), session-cookie
  middleware gate (`ACCESS_CODE` kept as dev fallback), `/login` + `/signup`,
  `getCurrentSession` / `requireUserId`.
- **Phase 5** Metering + quota — `plans`/`subscription`/`usage`, Free/Pro/Team caps,
  `assertGenerationQuota` (generation/token/media caps) + `recordGeneration`,
  signup auto-creates a Free subscription, `db:seed`, `/api/quota`.
- **Phase 6** Object storage — S3-compatible provider + env-based selection
  (`getStorageProvider`), `/api/assets/upload`.
- **Phase 7** Deploy — existing multi-stage `Dockerfile` already handles the native
  deps (sharp/canvas) + Next standalone; SaaS adds only pure-JS deps.

### Course data server-canonicalization — deferred (was Phase 3/4)

Investigation on `main` showed the app still persists courses via the legacy Dexie
layer (`lib/utils/database.ts`, `lib/utils/stage-storage.ts`); `@openmaic/storage`'s
`DocumentStore` is built + contract-tested but **not yet adopted by the app**, and its
roadmap lists `[ ] HTTP backend + reference server`. So "server-canonical course data"
done right = first migrate the app onto `DocumentStore`, then add its HTTP/Postgres
backend — a separate, sizable project. Building a parallel `lib/client/repo` now would
be a competing abstraction (slop). The skeleton therefore ships **local-first course
data + server-side gated/metered generation** — a valid, commercializable stance
("pay for the generation engine"). The server-canonical course-data path is the
documented next decision, with three options: full `DocumentStore` HTTP-backend
migration; lightweight client→server course sync; or keep local-first-generation-gated.

### Metering coverage

All billable, client-facing generation routes are quota-gated via
`requireUserWithQuota()` (authenticated + within plan caps) and record one generation:
`generate-classroom`, `chat`, `generate/{image,tts,video,voice,scene-content,scene-actions,
scene-outlines-stream,agent-profiles}`, `pbl/*`, `agent/edit`, `quiz-grade`, `web-search`,
`transcription`. (Verified these routes are client-entry-only — the classroom job runner
calls generation libs directly, not the routes, so gating does not break it.)

## 15. Run / deploy

```bash
# 1. infra
docker compose up -d postgres minio

# 2. env (copy .env.example → .env.local): set AUTH_SECRET, DATABASE_URL, S3_*

# 3. schema + seed
DATABASE_URL=… pnpm db:migrate
DATABASE_URL=… pnpm db:seed          # Free/Pro/Team plans

# 4. dev
pnpm dev

# 5. create the media bucket once (MinIO)
#    aws --endpoint-url $S3_ENDPOINT s3 mb s3://$S3_BUCKET
```

Production container (`docker compose --profile app up`) runs `node server.js` from the
Next standalone build; apply `db:migrate` + `db:seed` as a deploy step (the builder image
has the tooling). The SaaS branch requires Postgres + `AUTH_SECRET` to run (server imports
the DB client eagerly).

## 16. Pivot: multi-user SaaS on self-hosted Supabase + Redis (2026-07-16)

User clarification reshaped the target: **web-only (no desktop), multi-user concurrent,
self-hosted Supabase (full platform) + Redis.** This supersedes the lean better-auth path
above for the going-forward architecture.

Decisions:
- **Self-hosted Supabase (full platform):** Postgres + **GoTrue auth** (replaces
  better-auth) + **RLS** (`auth.uid()` row-level isolation) + Storage + Realtime (available).
- **Self-hosted Redis:** **BullMQ** job queue + separate **worker process** for the 300s
  classroom generation (the in-memory Map + filesystem JSON job store is broken for
  multi-user concurrent); per-user rate limiting; pub/sub for realtime.
- **Realtime:** Redis pub/sub + Next SSE (chosen over Supabase Realtime for fewer moving parts).
- **Server-canonical, web-only:** drop Tauri / local-first / offline; server is the system
  of record. Concurrency control via optimistic locking (`updatedAt`).
- **No front/back repo split:** multi-**process** monorepo (web + worker), not multi-repo.

Consequences for shipped feat/saas work:
- `better-auth` + `lib/auth.ts` + `lib/auth-client.ts` + `app/api/auth/[...all]` are
  **removed**; auth moves to Supabase GoTrue (`@supabase/ssr`).
- `db/schema.ts` auth tables (`user/session/account/verification`) are **removed** —
  Supabase owns the `auth` schema. Business/commerce tables keep `userId` (text), enforced
  by RLS policies + app-layer scoping. Signup→Free-subscription moves to a PG trigger.
- Phased (max-Supabase, "don't reinvent"): **A** Supabase auth (GoTrue) + RLS + infra →
  **B** **pg-boss** worker on Supabase Postgres for classroom generation (no Redis) →
  **C** course data over **Supabase auto REST + RLS** (supabase-js), Dexie dropped — no
  hand-rolled DocumentStore HTTP backend; DSL validation at server write time; optimistic
  concurrency via `updatedAt` → **D** Supabase Storage → **E** **Supabase Realtime**
  (`postgres_changes`) for multi-user live updates — no hand-rolled Redis+SSE → **F**
  rate-limiting (Redis optional / Edge Function, deferrable). Metering/quota stays custom
  Drizzle (no Supabase equivalent). Redis largely drops out.

Verification caveat: Supabase GoTrue/RLS **runtime** needs a running self-hosted Supabase
(`supabase start` or official compose, ~13 services) — typecheck/build stays green here;
the live auth/RLS flow is verified once Supabase is up locally.

## 17. Local dev with self-hosted Supabase (Docker)

Requires Docker. Uses the official Supabase CLI local stack (Docker under the hood).

1. Install the CLI: `winget install Supabase.Cli` (Windows) / `scoop install supabase` /
   `brew install supabase/tap/supabase` (macOS).
2. In the repo:
   ```
   supabase init        # creates supabase/ scaffolding (accept defaults)
   supabase start       # pulls + starts the local stack (Postgres, GoTrue, Storage, Realtime…)
   supabase status      # prints API URL + anon key + service_role key + DB URL
   ```
3. Copy the keys into `.env.local` (from `.env.example`):
   ```
   NEXT_PUBLIC_SUPABASE_URL=http://localhost:8000
   NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon from `supabase status`>
   SUPABASE_SERVICE_ROLE_KEY=<service_role from `supabase status`>
   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres
   REDIS_URL=redis://localhost:6379
   ```
4. Apply schema + RLS + seed:
   ```
   pnpm db:migrate
   psql "$DATABASE_URL" -f db/rls.sql      # or: supabase db execute --file db/rls.sql
   pnpm db:seed
   ```
5. Start Redis + the app:
   ```
   docker compose up -d redis
   pnpm dev
   ```
6. Smoke test: open `http://localhost:3000/signup` → register → (the `on_auth_user_created`
   trigger auto-creates a Free subscription) → `/api/quota` returns the Free plan + zero usage.

The CLI's local stack: Postgres at `localhost:5432` (postgres/postgres), the gateway
(API/Auth/Storage/Realtime) at `localhost:8000`. First run pulls a lot of images.
