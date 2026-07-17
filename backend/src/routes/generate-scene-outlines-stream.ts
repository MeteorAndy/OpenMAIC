/**
 * POST /api/generate/scene-outlines-stream — mirrors app/api/generate/scene-outlines-stream/route.ts.
 * SSE: ReadableStream + heartbeat; abort via c.req.raw.signal. All streaming
 * parser helpers are brought along verbatim; only the HTTP layer is adapted.
 */
import { Hono } from 'hono';
import { streamLLM } from '@/lib/ai/llm';
import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';
import {
  formatImageDescription,
  formatImagePlaceholder,
  buildVisionUserContent,
  uniquifyMediaElementIds,
  formatTeacherPersonaForPrompt,
} from '@/lib/generation/generation-pipeline';
import type { AgentInfo } from '@/lib/generation/generation-pipeline';
import { DEFAULT_LANGUAGE_DIRECTIVE } from '@/lib/generation/outline-generator';
import { MAX_PDF_CONTENT_CHARS, MAX_VISION_IMAGES } from '@/lib/constants/generation';
import { nanoid } from 'nanoid';
import type { UserRequirements, PdfImage, SceneOutline, ImageMapping } from '@/lib/types/generation';
import { apiError } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { resolveVocationalActive } from '@/lib/config/feature-flags';
import { requireUserWithQuota, recordGeneration } from '@/lib/server/quota';
import { authMiddleware, type AuthVars } from '../server/auth';
import { withNextUrl } from '../server/request';

const log = createLogger('Outlines Stream');

function extractLanguageDirective(buffer: string): string | null {
  const head = buffer.length > 8192 ? buffer.slice(0, 8192) : buffer;
  const match = head.match(/"languageDirective"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
}

const COURSE_TITLE_RE = /"courseTitle"\s*:\s*"((?:[^"\\]|\\.)*)"/;

function normalizeStreamedTitle(raw: string): string | null {
  let title: string;
  try {
    title = JSON.parse(`"${raw}"`);
  } catch {
    title = raw;
  }
  const normalized = title.trim();
  return normalized ? normalized.slice(0, 120) : null;
}

function extractCourseTitle(buffer: string): string | null {
  const head = buffer.length > 8192 ? buffer.slice(0, 8192) : buffer;
  const match = head.match(COURSE_TITLE_RE);
  return match ? normalizeStreamedTitle(match[1]) : null;
}

function extractCourseTitleFromComplete(buffer: string): string | null {
  const match = buffer.match(COURSE_TITLE_RE);
  return match ? normalizeStreamedTitle(match[1]) : null;
}

function extractNewOutlines(
  buffer: string,
  scanFrom: number,
): { outlines: SceneOutline[]; scanFrom: number } {
  const results: SceneOutline[] = [];

  let i: number;
  if (scanFrom > 0) {
    i = scanFrom;
  } else {
    const outlinesKeyIdx = buffer.indexOf('"outlines"');
    const arrayStart = outlinesKeyIdx >= 0 ? buffer.indexOf('[', outlinesKeyIdx) : buffer.indexOf('[');
    if (arrayStart === -1) return { outlines: results, scanFrom: 0 };
    i = arrayStart + 1;
  }

  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let escaped = false;
  let consumed = i;

  for (; i < buffer.length; i++) {
    const char = buffer[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === '{') {
      if (depth === 0) objectStart = i;
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0 && objectStart >= 0) {
        try {
          results.push(JSON.parse(buffer.substring(objectStart, i + 1)));
        } catch {
          // Incomplete or invalid JSON — skip
        }
        objectStart = -1;
        consumed = i + 1;
      }
    }
  }

  return { outlines: results, scanFrom: consumed };
}

function normalizeTaskEngineProceduralOutline(outline: SceneOutline, requirement: string): SceneOutline {
  const widgetOutline = outline.widgetOutline ?? {};
  return {
    ...outline,
    type: 'interactive',
    widgetType: 'procedural-skill',
    widgetOutline: {
      ...widgetOutline,
      procedureType: widgetOutline.procedureType ?? 'inspection',
      task: widgetOutline.task || requirement,
      tools: widgetOutline.tools && widgetOutline.tools.length > 0 ? widgetOutline.tools : ['required PPE', 'task checklist'],
      steps:
        widgetOutline.steps && widgetOutline.steps.length > 0
          ? widgetOutline.steps
          : ['Confirm task conditions', 'Select required tools', 'Complete safety check'],
      successCriteria:
        widgetOutline.successCriteria && widgetOutline.successCriteria.length > 0
          ? widgetOutline.successCriteria
          : ['Required checks completed', 'Unsafe conditions are not ignored'],
      errorConsequences:
        widgetOutline.errorConsequences && widgetOutline.errorConsequences.length > 0
          ? widgetOutline.errorConsequences
          : ['Unsafe or incorrect actions require stopping and rechecking'],
    },
  };
}

function normalizeTaskEngineSlideOutline(outline: SceneOutline): SceneOutline {
  const normalized: SceneOutline = { ...outline, type: 'slide' };
  delete normalized.widgetType;
  delete normalized.widgetOutline;
  delete normalized.interactiveConfig;
  return normalized;
}

const ORDINARY_WIDGET_TYPES = new Set(['simulation', 'diagram', 'code', 'game', 'visualization3d']);

function normalizeTaskEngineOutline(outline: SceneOutline, requirement: string): SceneOutline {
  if (outline.type === 'slide') {
    return normalizeTaskEngineSlideOutline(outline);
  }
  if (outline.type === 'interactive' && outline.widgetType === 'procedural-skill') {
    return normalizeTaskEngineProceduralOutline(outline, requirement);
  }
  if (outline.type === 'interactive' && outline.widgetType && ORDINARY_WIDGET_TYPES.has(outline.widgetType)) {
    return outline;
  }
  return normalizeTaskEngineSlideOutline(outline);
}

function sanitizeNonTaskEngineOutline(outline: SceneOutline): SceneOutline {
  if (outline.widgetType !== 'procedural-skill') {
    return outline;
  }
  const widgetOutline = { ...(outline.widgetOutline ?? {}) };
  delete widgetOutline.procedureType;
  delete widgetOutline.task;
  delete widgetOutline.tools;
  delete widgetOutline.steps;
  delete widgetOutline.successCriteria;
  delete widgetOutline.errorConsequences;
  return {
    ...outline,
    type: 'interactive',
    widgetType: 'diagram',
    description: outline.description
      ? `${outline.description} Present this as a process or structure diagram.`
      : 'Present this topic as a process or structure diagram.',
    widgetOutline,
  };
}

function ensureUniqueOutlineId(outline: SceneOutline, usedIds: Set<string>): SceneOutline {
  const candidate = typeof outline.id === 'string' && outline.id.trim() ? outline.id : undefined;
  if (candidate && !usedIds.has(candidate)) {
    usedIds.add(candidate);
    return outline;
  }
  let id = nanoid();
  while (usedIds.has(id)) {
    id = nanoid();
  }
  usedIds.add(id);
  return { ...outline, id };
}

export const generateSceneOutlinesStreamRoute = new Hono<AuthVars>();
generateSceneOutlinesStreamRoute.use('*', authMiddleware);

generateSceneOutlinesStreamRoute.post('/', async (c) => {
  const signal = c.req.raw.signal;
  let requirementSnippet: string | undefined;
  let resolvedModelString: string | undefined;
  try {
    const body = await c.req.json();

    const { model: languageModel, modelInfo, modelString, thinkingConfig } = await resolveModelFromRequest(
      withNextUrl(c.req.raw, c.req.url),
      body,
      'scene-outlines-stream',
    );
    resolvedModelString = modelString;

    if (!body.requirements) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Requirements are required');
    }

    const authed = await requireUserWithQuota();
    if (typeof authed !== 'string') return authed;
    void recordGeneration(authed);

    const { requirements, pdfText, pdfImages, imageMapping, researchContext, agents } = body as {
      requirements: UserRequirements;
      pdfText?: string;
      pdfImages?: PdfImage[];
      imageMapping?: ImageMapping;
      researchContext?: string;
      agents?: AgentInfo[];
    };
    requirementSnippet = requirements?.requirement?.substring(0, 60);

    const userProfileText =
      requirements.userNickname || requirements.userBio
        ? `## Student Profile\n\nStudent: ${requirements.userNickname || 'Unknown'}${requirements.userBio ? ` — ${requirements.userBio}` : ''}\n\nConsider this student's background when designing the course. Adapt difficulty, examples, and teaching approach accordingly.\n\n---`
        : '';

    const hasVision = !!modelInfo?.capabilities?.vision;

    let availableImagesText = 'No images available';
    let visionImages: Array<{ id: string; src: string; width?: number; height?: number }> | undefined;

    if (pdfImages && pdfImages.length > 0) {
      if (hasVision && imageMapping) {
        const allWithSrc = pdfImages.filter((img) => imageMapping[img.id]);
        const visionSlice = allWithSrc.slice(0, MAX_VISION_IMAGES);
        const textOnlySlice = allWithSrc.slice(MAX_VISION_IMAGES);
        const noSrcImages = pdfImages.filter((img) => !imageMapping[img.id]);

        const visionDescriptions = visionSlice.map((img) => formatImagePlaceholder(img));
        const textDescriptions = [...textOnlySlice, ...noSrcImages].map((img) => formatImageDescription(img));
        availableImagesText = [...visionDescriptions, ...textDescriptions].join('\n');

        visionImages = visionSlice.map((img) => ({ id: img.id, src: imageMapping[img.id], width: img.width, height: img.height }));
      } else {
        availableImagesText = pdfImages.map((img) => formatImageDescription(img)).join('\n');
      }
    }

    const imageGenerationEnabled = c.req.header('x-image-generation-enabled') === 'true';
    const videoGenerationEnabled = c.req.header('x-video-generation-enabled') === 'true';
    const mediaGenerationEnabled = imageGenerationEnabled || videoGenerationEnabled;
    const hasSourceImages = (pdfImages?.length ?? 0) > 0;

    const teacherContext = formatTeacherPersonaForPrompt(agents);

    const interactiveMode = requirements.interactiveMode ?? false;
    const taskEngineMode = resolveVocationalActive(requirements);
    const promptId = taskEngineMode
      ? PROMPT_IDS.TASK_ENGINE_OUTLINES
      : interactiveMode
        ? PROMPT_IDS.INTERACTIVE_OUTLINES
        : PROMPT_IDS.REQUIREMENTS_TO_OUTLINES;

    const prompts = buildPrompt(promptId, {
      requirement: requirements.requirement,
      pdfContent: pdfText ? pdfText.substring(0, MAX_PDF_CONTENT_CHARS) : 'None',
      availableImages: availableImagesText,
      researchContext: researchContext || 'None',
      hasSourceImages,
      imageEnabled: imageGenerationEnabled,
      videoEnabled: videoGenerationEnabled,
      mediaEnabled: mediaGenerationEnabled,
      teacherContext,
      userProfile: userProfileText,
    });

    if (!prompts) {
      return apiError('INTERNAL_ERROR', 500, 'Prompt template not found');
    }

    log.info(`Generating outlines: "${requirements.requirement.substring(0, 50)}" [model=${modelString}]`);

    const encoder = new TextEncoder();
    const HEARTBEAT_INTERVAL_MS = 15_000;
    const stream = new ReadableStream({
      async start(controller) {
        let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
        const startHeartbeat = () => {
          stopHeartbeat();
          heartbeatTimer = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(`:heartbeat\n\n`));
            } catch {
              stopHeartbeat();
            }
          }, HEARTBEAT_INTERVAL_MS);
        };
        const stopHeartbeat = () => {
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
        };

        const MAX_STREAM_RETRIES = 2;
        const MAX_OUTLINE_STREAM_BYTES = 512 * 1024;

        try {
          startHeartbeat();

          const streamParams = visionImages?.length
            ? {
                model: languageModel,
                system: prompts.system,
                messages: [{ role: 'user' as const, content: buildVisionUserContent(prompts.user, visionImages) }],
                maxOutputTokens: modelInfo?.outputWindow,
                abortSignal: signal,
              }
            : {
                model: languageModel,
                system: prompts.system,
                prompt: prompts.user,
                maxOutputTokens: modelInfo?.outputWindow,
                abortSignal: signal,
              };

          let parsedOutlines: SceneOutline[] = [];
          let languageDirective: string | null = null;
          let courseTitle: string | null = null;
          let lastError: string | undefined;

          for (let attempt = 1; attempt <= MAX_STREAM_RETRIES + 1; attempt++) {
            try {
              let fullText = '';
              let scanFrom = 0;
              parsedOutlines = [];
              languageDirective = null;
              courseTitle = null;
              const usedOutlineIds = new Set<string>();
              const textStream = streamLLM(streamParams, 'scene-outlines-stream', thinkingConfig).textStream;

              for await (const chunk of textStream) {
                if (signal?.aborted) {
                  stopHeartbeat();
                  return;
                }

                fullText += chunk;

                if (fullText.length > MAX_OUTLINE_STREAM_BYTES) {
                  log.warn(
                    `Outline stream exceeded ${MAX_OUTLINE_STREAM_BYTES} bytes (len=${fullText.length}); stopping read and finalizing with ${parsedOutlines.length} outline(s)`,
                  );
                  break;
                }

                if (!languageDirective) {
                  languageDirective = extractLanguageDirective(fullText);
                  if (languageDirective) {
                    const ldEvent = JSON.stringify({ type: 'languageDirective', data: languageDirective });
                    controller.enqueue(encoder.encode(`data: ${ldEvent}\n\n`));
                  }
                }

                if (!courseTitle) {
                  courseTitle = extractCourseTitle(fullText);
                  if (courseTitle) {
                    const ctEvent = JSON.stringify({ type: 'courseTitle', data: courseTitle });
                    controller.enqueue(encoder.encode(`data: ${ctEvent}\n\n`));
                  }
                }

                const { outlines: newOutlines, scanFrom: nextScanFrom } = extractNewOutlines(fullText, scanFrom);
                scanFrom = nextScanFrom;
                for (const outline of newOutlines) {
                  const enrichedBase = { ...outline, order: parsedOutlines.length + 1 };
                  const normalized = taskEngineMode
                    ? normalizeTaskEngineOutline(enrichedBase, requirements.requirement)
                    : sanitizeNonTaskEngineOutline(enrichedBase);
                  const enriched = ensureUniqueOutlineId(normalized, usedOutlineIds);
                  parsedOutlines.push(enriched);

                  const event = JSON.stringify({ type: 'outline', data: enriched, index: parsedOutlines.length - 1 });
                  controller.enqueue(encoder.encode(`data: ${event}\n\n`));
                }
              }

              if (parsedOutlines.length > 0) {
                if (!courseTitle) {
                  courseTitle = extractCourseTitleFromComplete(fullText);
                }
                break;
              }

              lastError = fullText.trim() ? 'LLM response could not be parsed into outlines' : 'LLM returned empty response';
              log.warn(
                `Outlines attempt ${attempt} diagnostics: textLen=${fullText.length}, outlines=${parsedOutlines.length}, languageDirective=${languageDirective ? 'yes' : 'no'}, preview=${JSON.stringify(fullText.slice(0, 240))}`,
              );

              if (attempt <= MAX_STREAM_RETRIES) {
                log.warn(`Empty outlines (attempt ${attempt}/${MAX_STREAM_RETRIES + 1}), retrying...`);
                const retryEvent = JSON.stringify({ type: 'retry', attempt, maxAttempts: MAX_STREAM_RETRIES + 1 });
                controller.enqueue(encoder.encode(`data: ${retryEvent}\n\n`));
              }
            } catch (error) {
              if (signal?.aborted) {
                stopHeartbeat();
                return;
              }
              lastError = error instanceof Error ? error.message : String(error);
              log.warn(`Outlines stream error detail (attempt ${attempt}/${MAX_STREAM_RETRIES + 1}): ${lastError}`);

              if (attempt <= MAX_STREAM_RETRIES) {
                log.warn(`Stream error (attempt ${attempt}/${MAX_STREAM_RETRIES + 1}), retrying...`, error);
                const retryEvent = JSON.stringify({ type: 'retry', attempt, maxAttempts: MAX_STREAM_RETRIES + 1 });
                controller.enqueue(encoder.encode(`data: ${retryEvent}\n\n`));
                continue;
              }
            }
          }

          if (parsedOutlines.length > 0) {
            const uniquifiedOutlines = uniquifyMediaElementIds(parsedOutlines);
            const doneEvent = JSON.stringify({
              type: 'done',
              outlines: uniquifiedOutlines,
              languageDirective: languageDirective || DEFAULT_LANGUAGE_DIRECTIVE,
              courseTitle: courseTitle || undefined,
              taskEngineMode,
            });
            controller.enqueue(encoder.encode(`data: ${doneEvent}\n\n`));
          } else {
            log.error(`Outline generation failed after ${MAX_STREAM_RETRIES + 1} attempts: ${lastError}`);
            const errorEvent = JSON.stringify({ type: 'error', error: lastError || 'Failed to generate outlines' });
            controller.enqueue(encoder.encode(`data: ${errorEvent}\n\n`));
          }
        } catch (error) {
          const errorEvent = JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : String(error) });
          controller.enqueue(encoder.encode(`data: ${errorEvent}\n\n`));
        } finally {
          stopHeartbeat();
          try {
            controller.close();
          } catch {
            /* already closed — ignore */
          }
        }
      },
    });

    return new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
    });
  } catch (error) {
    log.error(
      `Outline streaming failed [requirement="${requirementSnippet ?? 'unknown'}...", model=${resolvedModelString ?? 'unknown'}]:`,
      error,
    );
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : String(error));
  }
});
