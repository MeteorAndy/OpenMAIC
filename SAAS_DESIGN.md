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
