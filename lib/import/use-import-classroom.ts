'use client';

import { useState, useCallback, useRef } from 'react';
import { nanoid } from 'nanoid';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';
import { db, mediaFileKey } from '@/lib/utils/database';
import type { AudioFileRecord } from '@/lib/utils/database';
import { makeScene, type Stage, type Scene } from '@/lib/types/stage';
import {
  deleteCourse,
  upsertCourse,
  replaceGeneratedAgents,
  replaceScenes,
  upsertMediaFile,
} from '@/lib/supabase/queries';
import { uploadBlobToStorage } from '@/lib/storage/client';
import {
  agentConfigFromManifest,
  type ClassroomManifest,
  type ManifestScene,
} from '@/lib/export/classroom-zip-types';
import { rewriteAudioRefsToIds } from '@/lib/export/classroom-zip-utils';
import { z } from 'zod';
import { createLogger } from '@/lib/logger';

const log = createLogger('ImportClassroom');

// --- Import safety limits (untrusted ZIP + JSON boundary) ---
const MAX_ZIP_SIZE = 200 * 1024 * 1024; // hard reject over 200 MB
const MAX_ENTRIES = 2000; // zip entry count cap (zip-bomb backstop)
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB per extracted file
const MAX_EXTRACTED_TOTAL = 1024 * 1024 * 1024; // 1 GB cumulative extracted

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * JSON.parse that rejects prototype-polluting keys (parser-differential guard).
 * Throws (-> invalidManifest) if any property key is __proto__/constructor/prototype.
 */
function parseManifestSafe(text: string): unknown {
  return JSON.parse(text, (key, value) => {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new Error(`Forbidden key in manifest: ${key}`);
    }
    return value;
  });
}

/**
 * Validate the manifest structure + length-cap every DB-bound string field
 * (name/description/persona/title/...). Nested scene content/actions/whiteboards
 * are accepted opaquely (stored as jsonb) — only the human-text fields are capped.
 */
const ManifestSchema = z
  .object({
    stage: z
      .object({
        name: z.string().max(200).optional(),
        description: z.string().max(5000).optional(),
        language: z.string().max(200).optional(),
        style: z.string().max(200).optional(),
        createdAt: z.number().optional(),
      })
      .passthrough(),
    scenes: z
      .array(z.object({ title: z.string().max(300), order: z.number().optional() }).passthrough())
      .max(500),
    agents: z
      .array(
        z
          .object({
            name: z.string().max(100),
            role: z.string().max(50),
            persona: z.string().max(10000),
            avatar: z.string().max(1000),
            color: z.string().max(50),
            priority: z.number(),
          })
          .passthrough(),
      )
      .max(50)
      .optional(),
    mediaIndex: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type ImportPhase =
  | 'idle'
  | 'parsing'
  | 'validating'
  | 'writingMedia'
  | 'writingCourse'
  | 'done';

export function useImportClassroom(onSuccess?: () => void) {
  const [importing, setImporting] = useState(false);
  const [phase, setPhase] = useState<ImportPhase>('idle');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { t } = useI18n();

  const triggerFileSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      // Reset input so same file can be re-selected
      e.target.value = '';

      setImporting(true);
      setPhase('parsing');
      const toastId = toast.loading(t('import.parsing'));

      let importedStageId: string | undefined;
      const importedAudioIds: string[] = [];
      try {
        // 0. Hard size cap (untrusted upload boundary).
        if (file.size > MAX_ZIP_SIZE) {
          toast.error(t('import.error.invalidZip'), { id: toastId });
          return;
        }

        // 1. Parse ZIP
        const JSZip = (await import('jszip')).default;
        const zip = await JSZip.loadAsync(file);

        // Zip-bomb backstop: reject absurd entry counts.
        if (Object.keys(zip.files).length > MAX_ENTRIES) {
          toast.error(t('import.error.invalidZip'), { id: toastId });
          return;
        }

        const manifestFile = zip.file('manifest.json');
        if (!manifestFile) {
          toast.error(t('import.error.invalidManifest'), { id: toastId });
          return;
        }

        // 2. Validate
        setPhase('validating');
        toast.loading(t('import.validating'), { id: toastId });

        const manifestText = await manifestFile.async('text');
        let parsed: unknown;
        try {
          parsed = parseManifestSafe(manifestText);
        } catch {
          toast.error(t('import.error.invalidManifest'), { id: toastId });
          return;
        }
        const validated = ManifestSchema.safeParse(parsed);
        if (!validated.success) {
          log.warn('Import manifest failed validation:', validated.error.issues);
          toast.error(t('import.error.invalidManifest'), { id: toastId });
          return;
        }
        const manifest = validated.data as unknown as ClassroomManifest;
        if (!manifest.scenes || !Array.isArray(manifest.scenes)) {
          toast.error(t('import.error.missingData'), { id: toastId });
          return;
        }
        let extractedBytes = 0;

        // Validate mediaIndex zip paths (used as zip entry lookups + media keys):
        // confine to an audio|media prefix, no traversal, safe filename chars only.
        const VALID_ZIP_PATH = /^(audio|media)\/[A-Za-z0-9._-]+$/;
        for (const zipPath of Object.keys(manifest.mediaIndex ?? {})) {
          if (zipPath.includes('..') || !VALID_ZIP_PATH.test(zipPath)) {
            toast.error(t('import.error.invalidManifest'), { id: toastId });
            return;
          }
        }

        // 3. Generate new IDs
        const newStageId = nanoid();
        importedStageId = newStageId;
        const now = Date.now();

        // Agent ID mapping: index → new ID
        const newAgentIds: string[] = (manifest.agents ?? []).map(() => nanoid());
        const studentAgentIndex =
          manifest.agents?.findIndex((agent) => agent.role === 'student') ?? -1;
        const nonTeacherAgentIndex =
          manifest.agents?.findIndex((agent) => agent.role !== 'teacher') ?? -1;
        const fallbackDiscussionAgentIndex =
          studentAgentIndex >= 0
            ? studentAgentIndex
            : nonTeacherAgentIndex >= 0
              ? nonTeacherAgentIndex
              : undefined;

        // Audio ref → new ID mapping
        const audioRefToNewId: Record<string, string> = {};
        for (const [zipPath, entry] of Object.entries(manifest.mediaIndex ?? {})) {
          if (entry.type === 'audio' && !entry.missing) {
            audioRefToNewId[zipPath] = nanoid();
          }
        }

        // Media ref → new ID mapping
        const mediaRefToNewId: Record<string, string> = {};
        for (const [zipPath, entry] of Object.entries(manifest.mediaIndex ?? {})) {
          if ((entry.type === 'generated' || entry.type === 'image') && !entry.missing) {
            const filename = zipPath.split('/').pop() ?? '';
            const elementId = filename.replace(/\.\w+$/, '');
            mediaRefToNewId[zipPath] = mediaFileKey(newStageId, elementId);
          }
        }

        // 4. Write media to IndexedDB
        setPhase('writingMedia');
        toast.loading(t('import.writingMedia'), { id: toastId });

        // Write audio files one at a time
        for (const [zipPath, newId] of Object.entries(audioRefToNewId)) {
          const zipEntry = zip.file(zipPath);
          if (!zipEntry) continue;
          const blob = await zipEntry.async('blob');
          if (blob.size > MAX_FILE_SIZE) {
            log.warn(`Import: skipping oversize audio ${zipPath} (${blob.size}B)`);
            continue;
          }
          extractedBytes += blob.size;
          if (extractedBytes > MAX_EXTRACTED_TOTAL) {
            toast.error(t('import.error.invalidZip'), { id: toastId });
            return;
          }
          const meta = manifest.mediaIndex[zipPath];
          const record: AudioFileRecord = {
            id: newId,
            blob,
            format: meta.format || 'mp3',
            duration: meta.duration,
            voice: meta.voice,
            createdAt: now,
          };
          await db.audioFiles.put(record);
          importedAudioIds.push(newId);
        }

        // Upload + upsert generated media files one at a time (best-effort:
        // an upload failure skips that one file rather than aborting the import).
        // id (newId) is already the compound mediaFileKey(newStageId, elementId).
        for (const [zipPath, newId] of Object.entries(mediaRefToNewId)) {
          const zipEntry = zip.file(zipPath);
          if (!zipEntry) continue;
          const blob = await zipEntry.async('blob');
          if (blob.size > MAX_FILE_SIZE) {
            log.warn(`Import: skipping oversize media ${zipPath} (${blob.size}B)`);
            continue;
          }
          extractedBytes += blob.size;
          if (extractedBytes > MAX_EXTRACTED_TOTAL) {
            toast.error(t('import.error.invalidZip'), { id: toastId });
            return;
          }
          const meta = manifest.mediaIndex[zipPath];
          const type = meta.mimeType?.startsWith('video/') ? 'video' : 'image';
          const mimeType = meta.mimeType || 'image/jpeg';

          const ossKey = await uploadBlobToStorage(blob, 'media');
          if (!ossKey) {
            log.warn(`Import: skipping media ${zipPath} (object storage upload failed)`);
            continue;
          }

          // Poster entry (optional): upload separately as type 'poster'.
          const posterPath = zipPath.replace(/\.\w+$/, '.poster.jpg');
          const posterEntry = zip.file(posterPath);
          let posterOssKey: string | null = null;
          if (posterEntry) {
            const posterBlob = await posterEntry.async('blob');
            if (posterBlob.size > MAX_FILE_SIZE) {
              log.warn(`Import: skipping oversize poster for ${zipPath} (${posterBlob.size}B)`);
            } else {
              extractedBytes += posterBlob.size;
              if (extractedBytes > MAX_EXTRACTED_TOTAL) {
                toast.error(t('import.error.invalidZip'), { id: toastId });
                return;
              }
              posterOssKey = (await uploadBlobToStorage(posterBlob, 'poster')) ?? null;
            }
          }

          await upsertMediaFile({
            id: newId,
            courseId: newStageId,
            type,
            mimeType,
            size: meta.size || blob.size,
            prompt: meta.prompt || '',
            params: {},
            ossKey,
            posterOssKey,
            createdAt: now,
          });
        }

        // 5. Write course data
        setPhase('writingCourse');
        toast.loading(t('import.writingCourse'), { id: toastId });

        // Write stage (first write: no guard, last-write-wins matches the old Dexie put)
        const stageObj: Stage = {
          id: newStageId,
          name: manifest.stage.name || 'Imported Classroom',
          description: manifest.stage.description,
          languageDirective: manifest.stage.language,
          style: manifest.stage.style,
          createdAt: manifest.stage.createdAt || now,
          updatedAt: now,
          agentIds: newAgentIds.length > 0 ? newAgentIds : undefined,
        };
        await upsertCourse(newStageId, stageObj, null);

        // Write agents (delete-then-upsert by course_id; voiceConfig dropped)
        if (manifest.agents?.length) {
          const agentInputs = manifest.agents.map((agent, index) =>
            agentConfigFromManifest(agent, newAgentIds[index]),
          );
          await replaceGeneratedAgents(newStageId, agentInputs);
        }

        // Write scenes with rewritten references. makeScene()-bound (derives
        // `type` from content.type); manifest `whiteboards` (plural) maps to the
        // Scene.whiteboards plural field, which replaceScenes persists to the
        // singular DB `whiteboard` column.
        const scenes: Scene[] = manifest.scenes.map((mScene: ManifestScene, index: number) => {
          const newSceneId = nanoid();

          const actions = mScene.actions
            ? rewriteAudioRefsToIds(mScene.actions, audioRefToNewId, {
                agentIds: newAgentIds,
                fallbackDiscussionAgentIndex,
              })
            : undefined;

          let multiAgent = undefined;
          if (mScene.multiAgent?.enabled) {
            multiAgent = {
              enabled: true,
              agentIds: (mScene.multiAgent.agentIndices ?? [])
                .map((idx) => newAgentIds[idx])
                .filter(Boolean),
              directorPrompt: mScene.multiAgent.directorPrompt,
            };
          }

          return makeScene(
            {
              id: newSceneId,
              stageId: newStageId,
              title: mScene.title,
              order: mScene.order ?? index,
              actions,
              whiteboards: mScene.whiteboards,
              multiAgent,
              createdAt: now,
              updatedAt: now,
            },
            mScene.content,
          );
        });
        await replaceScenes(newStageId, scenes);

        // 6. Done
        setPhase('done');
        toast.success(t('import.success'), { id: toastId });
        onSuccess?.();
      } catch (error) {
        log.error('Classroom ZIP import failed:', error);
        // Compensate every durable row this import could have created, logging
        // individual failures. Object-storage blobs remain best-effort orphans.
        const cleanup = async (label: string, operation: () => Promise<unknown>) => {
          try {
            await operation();
          } catch (cleanupError) {
            log.error(`Failed to undo imported ${label}:`, cleanupError);
          }
        };
        if (importedStageId) {
          const stageId = importedStageId;
          await cleanup('course', () => deleteCourse(stageId));
        }
        if (importedAudioIds.length > 0) {
          await cleanup('audio files', () => db.audioFiles.bulkDelete(importedAudioIds));
        }
        const isQuotaError = error instanceof DOMException && error.name === 'QuotaExceededError';
        toast.error(isQuotaError ? t('import.error.storageFull') : t('import.error.invalidZip'), {
          id: toastId,
        });
      } finally {
        setImporting(false);
        setPhase('idle');
      }
    },
    [t, onSuccess],
  );

  return {
    importing,
    phase,
    fileInputRef,
    triggerFileSelect,
    handleFileChange,
  };
}
