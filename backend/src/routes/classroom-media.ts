/**
 * GET /api/classroom-media/:classroomId/:path+ — mirrors
 * app/_api_archive/classroom-media/[classroomId]/[...path]/route.ts.
 * Streams a media file from disk. Public (CDN-like). Multi-segment path captured
 * via Hono regexp param :path{.+} and split on '/'.
 */
import { promises as fs, createReadStream } from 'fs';
import path from 'path';
import { Hono } from 'hono';
import { CLASSROOMS_DIR, isValidClassroomId } from '@/lib/server/classroom-storage';
import { createLogger } from '@/lib/logger';

const log = createLogger('ClassroomMedia');

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.aac': 'audio/aac',
};

export const classroomMediaRoute = new Hono();

classroomMediaRoute.get('/:classroomId/:path{.+}', async (c) => {
  const classroomId = c.req.param('classroomId');
  // Multi-segment catch-all: Hono delivers the matched (slash-inclusive) string;
  // split to mirror Next's string[] param.
  const pathSegments = c.req.param('path').split('/').filter(Boolean);

  if (!isValidClassroomId(classroomId)) {
    return c.json({ error: 'Invalid classroom ID' }, 400);
  }

  const joined = pathSegments.join('/');
  if (joined.includes('..') || pathSegments.some((s) => s.includes('\0'))) {
    return c.json({ error: 'Invalid path' }, 400);
  }

  const subDir = pathSegments[0];
  if (subDir !== 'media' && subDir !== 'audio') {
    return c.json({ error: 'Invalid path' }, 404);
  }

  const filePath = path.join(CLASSROOMS_DIR, classroomId, ...pathSegments);
  const resolvedBase = path.resolve(CLASSROOMS_DIR, classroomId);

  try {
    const realPath = await fs.realpath(filePath);
    if (!realPath.startsWith(resolvedBase + path.sep) && realPath !== resolvedBase) {
      return c.json({ error: 'Not found' }, 404);
    }

    const stat = await fs.stat(realPath);
    if (!stat.isFile()) {
      return c.json({ error: 'Not found' }, 404);
    }

    const ext = path.extname(realPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    const stream = createReadStream(realPath);
    const webStream = new ReadableStream({
      start(controller) {
        stream.on('data', (chunk: Buffer | string) => controller.enqueue(chunk));
        stream.on('end', () => controller.close());
        stream.on('error', (err) => controller.error(err));
      },
      cancel() {
        stream.destroy();
      },
    });

    return new Response(webStream, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(stat.size),
        'Cache-Control': 'public, max-age=86400, immutable',
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return c.json({ error: 'Not found' }, 404);
    }
    log.error(`Classroom media serving failed [classroomId=${classroomId}, path=${joined}]:`, error);
    return c.json({ error: 'Internal error' }, 500);
  }
});
