import { describe, expect, it, vi } from 'vitest';

// The live classroom-deletion flow (app/page.tsx) goes through
// `deleteStageData` in stage-storage. After the C2 rewire it reads scenes via
// `@/lib/supabase/queries` (getScenes) and deletes via deleteCourse, so the
// queries module is mocked here. Mock the remaining module dependencies (the
// established pattern for database-touching code — no Supabase/Dexie in the
// node harness) and run the REAL deleteStageData to prove it cascades into the
// runtime layer.
vi.mock('@/lib/runtime/store', () => ({
  deleteStageRuntimeSafely: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/supabase/queries', () => ({
  // raw scene ids are collected BEFORE deleteCourse (CASCADE would empty them).
  getScenes: vi.fn().mockResolvedValue({ scenes: [], raw: [{ id: 'scene-1' }] }),
  deleteCourse: vi.fn().mockResolvedValue(undefined),
}));
// stage-storage still imports `db` from database for media reads
// (getFirstSlideByStages); this test never touches media, so a stub avoids
// loading real Dexie.
vi.mock('@/lib/utils/database', () => ({ db: {} }));
vi.mock('@/lib/utils/chat-storage', () => ({
  saveChatSessions: vi.fn(),
  loadChatSessions: vi.fn(),
  deleteChatSessions: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/utils/playback-storage', () => ({
  clearPlaybackState: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/quiz/persistence', () => ({
  clearAllForScene: vi.fn(),
}));

import { deleteStageData } from '@/lib/utils/stage-storage';
import { deleteStageRuntimeSafely } from '@/lib/runtime/store';

describe('deleteStageData runtime cascade', () => {
  it('cascades into the runtime store with the deleted stageId', async () => {
    await deleteStageData('stage-7');
    expect(vi.mocked(deleteStageRuntimeSafely)).toHaveBeenCalledExactlyOnceWith('stage-7');
  });
});
