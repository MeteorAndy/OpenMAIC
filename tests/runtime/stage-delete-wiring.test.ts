import { describe, expect, it, vi } from 'vitest';

const { deleteCourse, clearAllForScene } = vi.hoisted(() => ({
  deleteCourse: vi.fn().mockResolvedValue(undefined),
  clearAllForScene: vi.fn(),
}));

// The live classroom-deletion flow (app/page.tsx) goes through
// `deleteStageData` in stage-storage. After the C2 rewire it reads scenes via
// `@/lib/supabase/queries` (getScenes) and deletes via deleteCourse, so the
// queries module is mocked here. Mock the remaining module dependencies (the
// established pattern for database-touching code — no Supabase/Dexie in the
// node harness) and run the REAL deleteStageData to prove it cascades into the
// runtime layer.
vi.mock('@/lib/runtime/store', () => ({
  beginStageRuntimeDeletionSafely: vi.fn(() => ({
    completion: Promise.resolve(),
    settlement: Promise.resolve(),
  })),
}));
vi.mock('@/lib/supabase/queries', () => ({
  // raw scene ids are collected BEFORE deleteCourse (CASCADE would empty them).
  getScenes: vi.fn().mockResolvedValue({ scenes: [], raw: [{ id: 'scene-1' }] }),
  deleteCourse,
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
vi.mock('@/lib/quiz/persistence', () => ({
  clearAllForScene,
}));
import { deleteStageData } from '@/lib/utils/stage-storage';
import { beginStageRuntimeDeletionSafely } from '@/lib/runtime/store';

describe('deleteStageData runtime cascade', () => {
  it('cascades into the runtime store with the deleted stageId', async () => {
    await deleteStageData('stage-7');
    expect(vi.mocked(beginStageRuntimeDeletionSafely)).toHaveBeenCalledExactlyOnceWith('stage-7');
    expect(deleteCourse).toHaveBeenCalledExactlyOnceWith('stage-7');
    expect(clearAllForScene).toHaveBeenCalledWith('scene-1');
  });
});
