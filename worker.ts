/**
 * Standalone classroom-generation worker (BullMQ consumer over Redis).
 *
 * Run: `pnpm worker` (-> tsx worker.ts). A long-running Node process, separate from
 * the Next web app: it pulls jobs from the `classroom-generation` queue and runs
 * generateClassroom() in-process, streaming live progress back to Redis via
 * job.updateProgress() so the poll endpoint's progress bar advances smoothly.
 *
 * No HTTP server, no re-auth, no metering — auth + quota + metering already ran
 * exactly once on the POST route; the worker only does the heavy generation. baseUrl
 * comes from the job payload (the route baked in buildRequestOrigin(req) at enqueue).
 *
 * generateClassroom never fetch()es the web app (baseUrl is URL-string-construction
 * only), so no internal-auth/service-role path is needed.
 */
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import {
  CLASSROOM_QUEUE,
  type ClassroomJobData,
  type JobProgress,
  type JobTerminal,
} from './lib/server/queue';
import {
  generateClassroom,
} from './lib/server/classroom-generation';
import { createLogger } from './lib/logger';

const log = createLogger('ClassroomWorker');

if (!process.env.REDIS_URL) {
  throw new Error('REDIS_URL is not set (worker requires Redis)');
}
const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });

const worker = new Worker<ClassroomJobData, JobTerminal>(
  CLASSROOM_QUEUE,
  async (job) => {
    log.info('starting job', { jobId: job.id, userId: job.data.userId });

    const result = await generateClassroom(job.data.input, {
      baseUrl: job.data.baseUrl,
      onProgress: async (p) => {
        // Stream live progress to Redis -> the GET poll reads job.progress.
        await job.updateProgress({
          step: p.step,
          progress: p.progress,
          message: p.message,
          scenesGenerated: p.scenesGenerated,
          totalScenes: p.totalScenes,
        } satisfies JobProgress);
      },
    });

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
    } satisfies JobTerminal;
  },
  { connection, concurrency: 1 },
);

worker.on('failed', (job, err) => {
  log.error('job failed', job?.id, err);
});
log.info('classroom-generation worker started');

process.on('SIGTERM', async () => {
  try {
    await worker.close();
  } catch (err) {
    log.error('error stopping worker on SIGTERM', err);
  }
  process.exit(0);
});
