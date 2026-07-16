/**
 * restoreFromDB: media metadata now comes from Supabase media_file rows (C4).
 * Verifies the rows -> MediaTask mapping: oss_key is used verbatim as the render
 * URL (no blob:/createObjectURL), poster_oss_key as the video poster, row.error
 * surfaces as a failed task, and params is already a jsonb object (no JSON.parse).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MediaFileRow } from '@/lib/supabase/queries';

// Name starts with "mock" so vitest permits the hoisted factory to close over it.
const mockRows: Record<string, MediaFileRow[]> = {};

vi.mock('@/lib/supabase/queries', () => ({
  getMediaFiles: async (courseId: string) => mockRows[courseId] ?? [],
}));

// Imported AFTER vi.mock so the store binds the mocked getMediaFiles.
import { useMediaGenerationStore } from '@/lib/store/media-generation';

const STAGE = 'course-1';

function row(over: Partial<MediaFileRow> & { id: string; element_id: string }): MediaFileRow {
  return {
    user_id: 'u1',
    course_id: STAGE,
    type: 'image',
    mime_type: 'image/png',
    size: 100,
    prompt: 'a cat',
    params: { aspectRatio: '16:9', style: 'photo' },
    oss_key: 'https://cdn.example.com/media/cat.png',
    poster_oss_key: null,
    error: null,
    error_code: null,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  } as MediaFileRow;
}

beforeEach(() => {
  useMediaGenerationStore.setState({ tasks: {} });
  for (const k of Object.keys(mockRows)) delete mockRows[k];
});

describe('restoreFromDB (Supabase media_file rows -> MediaTask)', () => {
  it('maps oss_key to objectUrl verbatim (no blob: URL creation)', async () => {
    mockRows[STAGE] = [row({ id: `${STAGE}:gen_img_1`, element_id: 'gen_img_1' })];
    await useMediaGenerationStore.getState().restoreFromDB(STAGE);
    const task = useMediaGenerationStore.getState().getTask('gen_img_1');
    expect(task?.status).toBe('done');
    expect(task?.objectUrl).toBe('https://cdn.example.com/media/cat.png');
    expect(task?.objectUrl).not.toMatch(/^blob:/);
  });

  it('maps poster_oss_key to poster for video rows', async () => {
    mockRows[STAGE] = [
      row({
        id: `${STAGE}:gen_vid_1`,
        element_id: 'gen_vid_1',
        type: 'video',
        mime_type: 'video/mp4',
        oss_key: 'https://cdn.example.com/media/v.mp4',
        poster_oss_key: 'https://cdn.example.com/poster/v.jpg',
      }),
    ];
    await useMediaGenerationStore.getState().restoreFromDB(STAGE);
    const task = useMediaGenerationStore.getState().getTask('gen_vid_1');
    expect(task?.status).toBe('done');
    expect(task?.objectUrl).toBe('https://cdn.example.com/media/v.mp4');
    expect(task?.poster).toBe('https://cdn.example.com/poster/v.jpg');
  });

  it('surfaces row.error as a failed task (retryable via retryMediaTask)', async () => {
    mockRows[STAGE] = [
      row({
        id: `${STAGE}:gen_img_2`,
        element_id: 'gen_img_2',
        oss_key: null,
        error: 'content sensitive',
        error_code: 'CONTENT_SENSITIVE',
      }),
    ];
    await useMediaGenerationStore.getState().restoreFromDB(STAGE);
    const task = useMediaGenerationStore.getState().getTask('gen_img_2');
    expect(task?.status).toBe('failed');
    expect(task?.error).toBe('content sensitive');
    expect(task?.errorCode).toBe('CONTENT_SENSITIVE');
    expect(task?.objectUrl).toBeUndefined();
  });

  it('uses params as an object directly (no JSON.parse)', async () => {
    const params = { aspectRatio: '16:9', style: 'photo' };
    mockRows[STAGE] = [
      row({ id: `${STAGE}:gen_img_3`, element_id: 'gen_img_3', params }),
    ];
    await useMediaGenerationStore.getState().restoreFromDB(STAGE);
    const task = useMediaGenerationStore.getState().getTask('gen_img_3');
    expect(task?.params).toEqual(params);
  });
});
