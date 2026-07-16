/**
 * Standalone classroom-generation worker (pg-boss consumer).
 *
 * Run: `pnpm worker` (-> tsx worker.ts). A long-running Node process, separate
 * from the Next web app: it pulls jobs from the `classroom-generation` queue and
 * runs generateClassroom() in-process. No HTTP server, no re-auth, no metering —
 * auth + quota + metering already ran exactly once on the POST route; the worker
 * only does the heavy generation. baseUrl comes from the job payload (the route
 * baked in buildRequestOrigin(req) at enqueue time).
 *
 * Imports the web app's server modules as-is (plain TS, not Next-coupled).
 * generateClassroom calls every callee (callLLM, outline/scene generators,
 * searchWeb, media, TTS, persistClassroom) as direct in-process functions; it
 * never fetch()es the web app, so no internal-auth/service-role path is needed.
 */
import PgBoss from 'pg-boss';
import { getBoss, CLASSROOM_QUEUE, type JobOutput } from './lib/server/queue';
import {
  generateClassroom,
  type GenerateClassroomInput,
} from './lib/server/classroom-generation';
import { createLogger } from './lib/logger';

const log = createLogger('ClassroomWorker');

interface JobPayload {
  input: GenerateClassroomInput;
  baseUrl: string;
  userId: string;
}

const handler: PgBoss.WorkHandler<JobPayload> = async (jobs) => {
  const job = jobs[0];
  log.info('starting job', { jobId: job.id, userId: job.data.userId });

  try {
    const result = await generateClassroom(job.data.input, {
      baseUrl: job.data.baseUrl,
      onProgress: async () => {
        // pg-boss v10 has no live-progress write — the job stays 'active' with
        // coarse status until completion. See lib/server/queue.ts deviation note.
      },
    });

    // Returning this object lets pg-boss store it as the job's `output` (single-
    // job batch -> complete(name, id, result)), which GET reads on completion.
    return {
      step: 'completed',
      progress: 100,
      message: 'Classroom generation completed',
      scenesGenerated: result.scenesCount,
      totalScenes: result.scenesCount,
      result: {
        classroomId: result.id,
        url: result.url,
        scenesCount: result.scenesCount,
      },
    } satisfies JobOutput;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('job failed', job.id, err);
    try {
      await boss.fail(CLASSROOM_QUEUE, job.id, { step: 'failed', message, error: message });
    } catch (markFailedError) {
      log.error(`Failed to persist failed status for job ${job.id}:`, markFailedError);
    }
    // Do not rethrow: the job is already failed via the explicit boss.fail(), and
    // a thrown Error would trigger pg-boss's internal fail() with a lossy
    // stringified payload. On this resolve path pg-boss's internal complete() is
    // a no-op against the now-failed row. retryLimit:0 => it is not retried, so
    // there is no double-write of media/audio/classroom files.
    return { step: 'failed', message, error: message } satisfies JobOutput;
  }
};

const boss = await getBoss();
await boss.work(CLASSROOM_QUEUE, { batchSize: 1 }, handler);
log.info('classroom-generation worker started');

process.on('SIGTERM', async () => {
  try {
    await boss.stop();
  } catch (err) {
    log.error('error stopping pg-boss on SIGTERM', err);
  }
  process.exit(0);
});
