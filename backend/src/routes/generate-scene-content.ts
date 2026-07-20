/**
 * POST /api/generate/scene-content — mirrors app/_api_archive/generate/scene-content/route.ts.
 * HTTP layer only; generation-pipeline + llm + resolve-model reused unchanged.
 */
import { Hono } from 'hono';
import { callLLM } from '@/lib/ai/llm';
import { applyOutlineFallbacks, generateSceneContent, buildVisionUserContent } from '@/lib/generation/generation-pipeline';
import type { AgentInfo } from '@/lib/generation/generation-pipeline';
import type { SceneOutline, PdfImage, ImageMapping, UserRequirements } from '@/lib/types/generation';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { llmApiError } from '@/lib/server/llm-error-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { resolveVocationalActive } from '@/lib/config/feature-flags';
import { requireUserWithQuota, recordGeneration } from '@/lib/server/quota';
import { authMiddleware, type AuthVars } from '../server/auth';
import { withNextUrl } from '../server/request';

const log = createLogger('Scene Content API');

export const generateSceneContentRoute = new Hono<AuthVars>();
generateSceneContentRoute.use('*', authMiddleware);

generateSceneContentRoute.post('/', async (c) => {
  let outlineTitle: string | undefined;
  let resolvedModelString: string | undefined;
  try {
    const body = await c.req.json();
    const {
      outline: rawOutline,
      allOutlines,
      pdfImages,
      imageMapping,
      stageInfo: _stageInfo,
      stageId,
      agents,
      languageDirective,
      requirements,
    } = body as {
      outline: SceneOutline;
      allOutlines: SceneOutline[];
      pdfImages?: PdfImage[];
      imageMapping?: ImageMapping;
      stageInfo: { name: string; description?: string; style?: string };
      stageId: string;
      agents?: AgentInfo[];
      languageDirective?: string;
      requirements?: UserRequirements;
    };

    if (!rawOutline) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'outline is required');
    }
    if (!allOutlines || allOutlines.length === 0) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'allOutlines is required and must not be empty');
    }
    if (!stageId) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'stageId is required');
    }

    const authed = await requireUserWithQuota();
    if (typeof authed !== 'string') return authed;
    void recordGeneration(authed);

    const outline: SceneOutline = { ...rawOutline };

    const stage = outline.type ? (`scene-content:${outline.type}` as const) : 'scene-content';
    const { model: languageModel, modelInfo, modelString, thinkingConfig } = await resolveModelFromRequest(
      withNextUrl(c.req.raw, c.req.url),
      body,
      stage,
    );
    outlineTitle = rawOutline?.title;
    resolvedModelString = modelString;

    const hasVision = !!modelInfo?.capabilities?.vision;

    const aiCall = async (
      systemPrompt: string,
      userPrompt: string,
      images?: Array<{ id: string; src: string }>,
    ): Promise<string> => {
      if (images?.length && hasVision) {
        const result = await callLLM(
          {
            model: languageModel,
            system: systemPrompt,
            messages: [{ role: 'user' as const, content: buildVisionUserContent(userPrompt, images) }],
            maxOutputTokens: modelInfo?.outputWindow,
            maxRetries: 0,
          },
          'scene-content',
          undefined,
          thinkingConfig,
        );
        return result.text;
      }
      const result = await callLLM(
        { model: languageModel, system: systemPrompt, prompt: userPrompt, maxOutputTokens: modelInfo?.outputWindow, maxRetries: 0 },
        'scene-content',
        undefined,
        thinkingConfig,
      );
      return result.text;
    };

    const vocationalActive = resolveVocationalActive(requirements);
    const effectiveOutline = applyOutlineFallbacks(outline, !!languageModel, { allowProceduralSkill: vocationalActive });

    let assignedImages: PdfImage[] | undefined;
    if (
      pdfImages &&
      pdfImages.length > 0 &&
      effectiveOutline.suggestedImageIds &&
      effectiveOutline.suggestedImageIds.length > 0
    ) {
      const suggestedIds = new Set(effectiveOutline.suggestedImageIds);
      assignedImages = pdfImages.filter((img) => suggestedIds.has(img.id));
    }

    const generatedMediaMapping: ImageMapping = {};

    log.info(`Generating content: "${effectiveOutline.title}" (${effectiveOutline.type}) [model=${modelString}]`);

    const userLocale = c.req.header('x-user-locale') ?? '';

    const content = await generateSceneContent(effectiveOutline, aiCall, {
      assignedImages,
      imageMapping,
      languageModel: effectiveOutline.type === 'pbl' ? languageModel : undefined,
      visionEnabled: hasVision,
      generatedMediaMapping,
      agents,
      languageDirective,
      thinkingConfig,
      targetLanguage: userLocale || undefined,
      userRequirements: requirements,
      allowProceduralSkill: vocationalActive,
    });

    if (!content) {
      log.error(`Failed to generate content for: "${effectiveOutline.title}"`);
      return apiError('GENERATION_FAILED', 500, `Failed to generate content: ${effectiveOutline.title}`);
    }

    log.info(`Content generated successfully: "${effectiveOutline.title}"`);
    return apiSuccess({ content, effectiveOutline });
  } catch (error) {
    log.error(
      `Scene content generation failed [scene="${outlineTitle ?? 'unknown'}", model=${resolvedModelString ?? 'unknown'}]:`,
      error,
    );
    return llmApiError(error);
  }
});
