import { test, expect } from '../fixtures/base';
import { GenerationPreviewPage } from '../pages/generation-preview.page';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { mockOutlines } from '../fixtures/test-data/scene-outlines';

const SETTINGS_STORAGE = createSettingsStorage();

const GENERATION_SESSION = JSON.stringify({
  sessionId: 'e2e-completeness',
  requirements: { requirement: '讲解光合作用', language: 'zh-CN' },
  pdfText: '',
  pdfImages: [],
  imageStorageIds: [],
  sceneOutlines: null,
  currentStep: 'generating',
});

test.describe('Generation completeness', () => {
  // Guards the "only the first PPT generates" symptom from the user-facing
  // angle: the whole course must come through — every outline becomes a scene,
  // in order, nothing skipped. Relies on the server-side scene-generator
  // robustness that lives on main (null-stripping / per-element try-catch in
  // 5daf3e5 + fcdb6d6); the feat branch is 6 commits behind and lacks it.
  test('generates the full course — every outline becomes a scene', async ({ page, mockApi }) => {
    test.setTimeout(150000);
    await page.addInitScript(
      ({ settings, session }) => {
        localStorage.setItem('settings-storage', settings);
        sessionStorage.setItem('generationSession', session);
      },
      { settings: SETTINGS_STORAGE, session: GENERATION_SESSION },
    );

    await mockApi.setupGenerationMocks();

    const preview = new GenerationPreviewPage(page);
    await preview.goto();
    await page.waitForURL(/\/classroom\//, { timeout: 120_000 });

    const classroom = new ClassroomPage(page);
    await classroom.waitForLoaded();

    // generateRemaining runs after classroom mount and fills in scenes 2..N.
    // Poll until every outline has been turned into a scene — no skips.
    await expect
      .poll(async () => classroom.sidebarScenes.count(), {
        timeout: 30_000,
        message: `all ${mockOutlines.length} outlines generated as scenes`,
      })
      .toBe(mockOutlines.length);

    // First scene title still matches (scene 1, generated in preview).
    await expect(classroom.getSceneTitle(0)).toContainText('光合作用');
  });
});
