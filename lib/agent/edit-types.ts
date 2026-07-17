/**
 * Shared types for the MAIC Agent SSE edit endpoint.
 *
 * Lives in `lib/` so client and server code can depend on it without importing
 * from `app/api/**` (the Next route is shadowed by the SaaS backend proxy and is
 * not a stable import target for lib/client code).
 */
import type { SceneContext } from '@/lib/agent/tools/regenerate-scene-actions';

/**
 * Scene/stage context map sent by the client.
 * Keyed by scene id; the client reads `useStageStore` to build this so the
 * server never has to access a (non-existent) server-side scene store.
 */
export type SceneContextMap = Record<string, SceneContext>;
