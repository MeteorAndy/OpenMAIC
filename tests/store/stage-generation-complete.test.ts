import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// stage-storage / supabase-queries modules are imported dynamically inside the
// store's save/load actions. Mock them so we can drive load inputs and observe
// persistence without a real backend. Spies go through vi.hoisted so they exist
// before the hoisted vi.mock factories run.
//
// C2: outline persistence moved from db.stageOutlines (Dexie) to course.outline
// jsonb via @/lib/supabase/queries (getCourse reads the guard, setCourseOutline
// writes {outlines, generationComplete}). loadFromStorage reads outline from
// loadStageData (single getCourse round trip).
const {
  loadStageDataMock,
  saveStageDataMock,
  getCourseMock,
  setCourseOutlineMock,
} = vi.hoisted(() => ({
  loadStageDataMock: vi.fn(),
  saveStageDataMock: vi.fn().mockResolvedValue(undefined),
  getCourseMock: vi.fn(),
  setCourseOutlineMock: vi.fn().mockResolvedValue('guard-1'),
}));
vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: (...args: unknown[]) => saveStageDataMock(...args),
  loadStageData: (...args: unknown[]) => loadStageDataMock(...args),
}));
vi.mock('@/lib/supabase/queries', () => ({
  getCourse: (...args: unknown[]) => getCourseMock(...args),
  setCourseOutline: (...args: unknown[]) => setCourseOutlineMock(...args),
  ConcurrencyConflictError: class ConcurrencyConflictError extends Error {},
}));

import { useStageStore } from '@/lib/store/stage';
import type { Scene, Stage } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';

function makeStage(): Stage {
  return { id: 'stage-1', name: 'Test stage', createdAt: 1, updatedAt: 1 };
}

function makeSlideScene(id: string, order: number, stageId = 'stage-1'): Scene {
  return {
    id,
    stageId,
    type: 'slide',
    title: id,
    order,
    content: {
      type: 'slide',
      canvas: {
        id: `canvas-${id}`,
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          backgroundColor: '#fff',
          themeColors: ['#000'],
          fontColor: '#000',
          fontName: 'Inter',
        },
        elements: [],
      },
    },
  };
}

function makeOutline(order: number): SceneOutline {
  return {
    id: `outline-${order}`,
    type: 'slide',
    title: `outline ${order}`,
    description: 'desc',
    keyPoints: ['k1'],
    order,
  };
}

beforeEach(() => {
  useStageStore.getState().clearStore();
  getCourseMock.mockReset();
  setCourseOutlineMock.mockReset();
  setCourseOutlineMock.mockResolvedValue('guard-1');
  getCourseMock.mockResolvedValue({ stage: makeStage(), guard: 'guard-1', outline: null });
  loadStageDataMock.mockReset();
});

afterEach(async () => {
  try {
    if (vi.isFakeTimers()) {
      await vi.runOnlyPendingTimersAsync();
      expect(vi.getTimerCount()).toBe(0);
    }
  } finally {
    if (vi.isFakeTimers()) {
      vi.useRealTimers();
    }
    useStageStore.getState().clearStore();
  }
});

describe('generationComplete', () => {
  it('defaults to false', () => {
    expect(useStageStore.getState().generationComplete).toBe(false);
  });

  it('setGenerationComplete(true) flips the flag and persists it alongside outlines', async () => {
    useStageStore.setState({ stage: makeStage(), outlines: [makeOutline(1), makeOutline(2)] });
    useStageStore.getState().setGenerationComplete(true);
    expect(useStageStore.getState().generationComplete).toBe(true);
    // Persisted via an async dynamic import (getCourse RMW -> setCourseOutline).
    await vi.waitFor(() => expect(setCourseOutlineMock).toHaveBeenCalled());
    const [courseId, payload] = setCourseOutlineMock.mock.calls.at(-1)! as [
      string,
      { outlines: SceneOutline[]; generationComplete?: boolean },
    ];
    expect(courseId).toBe('stage-1');
    expect(payload.generationComplete).toBe(true);
    expect(payload.outlines.map((o) => o.order)).toEqual([1, 2]);
  });

  // Guards a persistence race: the final scene saves through a 500ms debounce,
  // so the flag must not reach the DB before the scenes do — else a reload
  // would trust the flag and drop the unsaved final slide.
  it('flushes scenes before persisting the completion flag', async () => {
    useStageStore.setState({ stage: makeStage(), outlines: [makeOutline(1)] });
    saveStageDataMock.mockClear();
    setCourseOutlineMock.mockClear();

    useStageStore.getState().setGenerationComplete(true);

    await vi.waitFor(() => expect(setCourseOutlineMock).toHaveBeenCalled());
    expect(saveStageDataMock).toHaveBeenCalled();
    // Scene flush must be ordered before the flag write.
    expect(saveStageDataMock.mock.invocationCallOrder[0]).toBeLessThan(
      setCourseOutlineMock.mock.invocationCallOrder[0],
    );
  });

  it('does not persist the completion flag when the scene flush fails', async () => {
    useStageStore.setState({ stage: makeStage(), outlines: [makeOutline(1)] });
    saveStageDataMock.mockRejectedValueOnce(new Error('disk full'));
    setCourseOutlineMock.mockClear();

    useStageStore.getState().setGenerationComplete(true);
    // In-memory flag still flips (UI), but the durable record must not be
    // written ahead of the scenes — else a reload would drop the unsaved slide.
    expect(useStageStore.getState().generationComplete).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(setCourseOutlineMock).not.toHaveBeenCalled();
  });

  it('starting a new stage resets generationComplete to false', () => {
    vi.useFakeTimers();
    useStageStore.setState({ generationComplete: true });
    useStageStore.getState().setStage(makeStage());
    expect(useStageStore.getState().generationComplete).toBe(false);
  });

  describe('deleteScene preserves completion', () => {
    // A deck complete-by-count but missing the flag (e.g. generated before the
    // flag existed, or edited without a reload so self-heal never ran) must
    // record completion when a slide is deleted — otherwise the count breaks
    // and the "Course complete" end page disappears.
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('marks complete when deleting from a fully-materialized deck whose flag was unset', () => {
      useStageStore.setState({
        stage: makeStage(),
        scenes: [makeSlideScene('a', 1), makeSlideScene('b', 2), makeSlideScene('c', 3)],
        outlines: [makeOutline(1), makeOutline(2), makeOutline(3)],
        failedOutlines: [],
        generationComplete: false,
        currentSceneId: 'b',
      });
      useStageStore.getState().deleteScene('b');
      expect(useStageStore.getState().generationComplete).toBe(true);
      expect(useStageStore.getState().scenes.map((s) => s.order)).toEqual([1, 3]);
    });

    it('does not mark complete when deleting from a still-incomplete deck', () => {
      useStageStore.setState({
        stage: makeStage(),
        scenes: [makeSlideScene('a', 1), makeSlideScene('b', 2)], // outline order 3 not materialized
        outlines: [makeOutline(1), makeOutline(2), makeOutline(3)],
        failedOutlines: [],
        generationComplete: false,
        currentSceneId: 'a',
      });
      useStageStore.getState().deleteScene('b');
      expect(useStageStore.getState().generationComplete).toBe(false);
    });

    it('keeps generationComplete true when deleting from an already-complete deck', () => {
      useStageStore.setState({
        stage: makeStage(),
        scenes: [makeSlideScene('a', 1), makeSlideScene('b', 2)],
        outlines: [makeOutline(1), makeOutline(2)],
        failedOutlines: [],
        generationComplete: true,
        currentSceneId: 'a',
      });
      useStageStore.getState().deleteScene('b');
      expect(useStageStore.getState().generationComplete).toBe(true);
    });
  });

  describe('markGenerationCompleteIfDone', () => {
    it('marks complete when every outline has a scene and none failed', () => {
      useStageStore.setState({
        stage: makeStage(),
        scenes: [makeSlideScene('a', 1), makeSlideScene('b', 2)],
        outlines: [makeOutline(1), makeOutline(2)],
        failedOutlines: [],
        generationComplete: false,
      });
      useStageStore.getState().markGenerationCompleteIfDone();
      expect(useStageStore.getState().generationComplete).toBe(true);
    });

    it('does not mark complete while an outline is still unmaterialized', () => {
      useStageStore.setState({
        stage: makeStage(),
        scenes: [makeSlideScene('a', 1)],
        outlines: [makeOutline(1), makeOutline(2)],
        failedOutlines: [],
        generationComplete: false,
      });
      useStageStore.getState().markGenerationCompleteIfDone();
      expect(useStageStore.getState().generationComplete).toBe(false);
    });

    it('does not mark complete while an outline is still failed', () => {
      useStageStore.setState({
        stage: makeStage(),
        scenes: [makeSlideScene('a', 1), makeSlideScene('b', 2)],
        outlines: [makeOutline(1), makeOutline(2)],
        failedOutlines: [makeOutline(2)],
        generationComplete: false,
      });
      useStageStore.getState().markGenerationCompleteIfDone();
      expect(useStageStore.getState().generationComplete).toBe(false);
    });
  });

  // The core regression: a completed deck must not resurrect a deleted slide.
  // On reload the orphaned outline (no matching scene) must NOT become a
  // generating placeholder, and the flag must round-trip.
  it('drops generating placeholders on load when generation already completed', async () => {
    loadStageDataMock.mockResolvedValue({
      stage: makeStage(),
      scenes: [makeSlideScene('a', 1), makeSlideScene('b', 2)], // order 3 was deleted
      currentSceneId: 'a',
      chats: [],
      outline: {
        outlines: [makeOutline(1), makeOutline(2), makeOutline(3)], // orphan order 3
        generationComplete: true,
      },
    });

    await useStageStore.getState().loadFromStorage('stage-1');

    expect(useStageStore.getState().generationComplete).toBe(true);
    expect(useStageStore.getState().generatingOutlines).toEqual([]);
  });

  // Backward-compat: a deck generated before the flag existed has no
  // generationComplete in its outline. If every outline already has a scene it
  // is fully generated, so it must self-heal to complete (and persist) — else
  // the first deletion would regenerate the slide.
  it('infers and persists completion for a legacy fully-generated deck', async () => {
    loadStageDataMock.mockResolvedValue({
      stage: makeStage(),
      scenes: [makeSlideScene('a', 1), makeSlideScene('b', 2), makeSlideScene('c', 3)],
      currentSceneId: 'a',
      chats: [],
      outline: {
        outlines: [makeOutline(1), makeOutline(2), makeOutline(3)], // all materialized, no flag
      },
    });

    await useStageStore.getState().loadFromStorage('stage-1');

    expect(useStageStore.getState().generationComplete).toBe(true);
    expect(useStageStore.getState().generatingOutlines).toEqual([]);
    // Healed flag is written back to course.outline so the next load is authoritative.
    await vi.waitFor(() => expect(setCourseOutlineMock).toHaveBeenCalled());
    const healed = setCourseOutlineMock.mock.calls.at(-1)![1] as { generationComplete?: boolean };
    expect(healed.generationComplete).toBe(true);
  });

  // Resume-on-refresh for a genuinely interrupted generation is preserved:
  // when not complete, the missing outline still drives a placeholder.
  it('keeps generating placeholders on load when generation is not complete', async () => {
    loadStageDataMock.mockResolvedValue({
      stage: makeStage(),
      scenes: [makeSlideScene('a', 1), makeSlideScene('b', 2)],
      currentSceneId: 'a',
      chats: [],
      outline: {
        outlines: [makeOutline(1), makeOutline(2), makeOutline(3)],
        generationComplete: false,
      },
    });

    await useStageStore.getState().loadFromStorage('stage-1');

    expect(useStageStore.getState().generationComplete).toBe(false);
    expect(useStageStore.getState().generatingOutlines.map((o) => o.order)).toEqual([3]);
  });
});
