/**
 * pg-boss queue (singleton over DATABASE_URL).
 *
 * ponytail: no new DB pool, no new Drizzle table. Job lifecycle + terminal
 * state live in pg-boss's own `pgboss` schema (installed idempotently by
 * start()). One read path (getJobById), no fs, no mutex, no stale heuristic —
 * pg-boss native expiry (expireInSeconds) replaces the old 30-min stale check.
 *
 * DEVIATION FROM STAGE B SPEC (reality check): the spec assumed a pg-boss
 * `job.updateProgress()` API and a `job.progress` field. **No pg-boss version
 * (v10 or v12) has any progress concept** — those are BullMQ APIs. The spec
 * deliberately chose Postgres-backed pg-boss over Redis/BullMQ, so we honor
 * that and carry terminal progress in pg-boss's real `output` field (set on
 * complete/fail). Mid-flight polling is therefore COARSE: queued -> running ->
 * succeeded|failed, with the final result/error landing in `output`. The full
 * GET response SHAPE is unchanged (every key still present), only the running
 * progress bar stops advancing smoothly. Upgrade paths if smooth progress is
 * needed later: (a) move the queue to BullMQ+Redis (both already in deps +
 * compose), which has native updateProgress; or (b) add a tiny progress table.
 */
import PgBoss from 'pg-boss';
import type { GenerateClassroomInput } from '@/lib/server/classroom-generation';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set');
}

export const CLASSROOM_QUEUE = 'classroom-generation';

const boss = new PgBoss(process.env.DATABASE_URL!);
// start() is idempotent: installs the pgboss schema (its own tables, does NOT
// touch our Drizzle schema) and starts maintenance. Kicked once at module load.
const startPromise = boss.start();

export async function getBoss(): Promise<PgBoss> {
  await startPromise;
  return boss;
}

/** Terminal payload the worker writes to the job's `output` via complete/fail. */
export interface JobOutput {
  step?: string;
  progress?: number;
  message?: string;
  scenesGenerated?: number;
  totalScenes?: number;
  result?: { classroomId: string; url: string; scenesCount: number };
  error?: string;
}

export interface JobPollResponse {
  jobId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  step: string;
  progress: number;
  message: string;
  pollIntervalMs: 5000;
  scenesGenerated: number;
  totalScenes?: number;
  result?: { classroomId: string; url: string; scenesCount: number };
  error?: string;
  done: boolean;
}

export function isValidClassroomJobId(jobId: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(jobId);
}

/**
 * Enqueue a classroom generation job. Returns pg-boss uuid (satisfies
 * isValidClassroomJobId). expireInSeconds:1800 reproduces the old 30-min stale
 * ceiling (pg-boss flips the job out of active on expiry if the worker dies).
 * retryLimit:0 — generation writes media/audio/JSON and is NOT idempotent.
 */
export async function enqueueClassroomJob(
  input: GenerateClassroomInput,
  baseUrl: string,
  userId: string,
): Promise<string> {
  const b = await getBoss();
  const jobId = await b.send(
    CLASSROOM_QUEUE,
    { input, baseUrl, userId },
    { expireInSeconds: 1800, retryLimit: 0 },
  );
  if (!jobId) throw new Error('Failed to enqueue classroom generation job');
  return jobId;
}

/**
 * Map a pg-boss job row onto the poll shape the GET route returns. Returns null
 * when the job no longer exists (getJobById null after archive) — caller 404s.
 */
export async function getJobStatus(jobId: string): Promise<JobPollResponse | null> {
  const b = await getBoss();
  const job = await b.getJobById(CLASSROOM_QUEUE, jobId);
  if (!job) return null;

  // Widen to string so we can also match runtime states pg-boss may introduce
  // (e.g. 'expired' from maintenance) without a TS error on the literal union.
  const state: string = job.state;
  const out: JobOutput =
    job.output && typeof job.output === 'object' ? (job.output as JobOutput) : {};

  let status: JobPollResponse['status'];
  let step: string;
  let progress: number;
  let message: string;
  let scenesGenerated = out.scenesGenerated ?? 0;
  let totalScenes = out.totalScenes;
  let result = out.result;
  let error = out.error;

  if (state === 'created') {
    status = 'queued';
    step = 'queued';
    progress = 0;
    message = 'Classroom generation job queued';
    scenesGenerated = 0;
  } else if (state === 'active') {
    status = 'running';
    step = 'running';
    progress = 0;
    message = 'Classroom generation running';
    scenesGenerated = 0;
  } else if (state === 'completed') {
    status = 'succeeded';
    step = out.step ?? 'completed';
    progress = 100;
    message = out.message ?? 'Classroom generation completed';
    result = out.result;
  } else {
    // failed | expired | cancelled | retry (with retryLimit:0, retry can't occur)
    status = 'failed';
    step = 'failed';
    progress = out.progress ?? 0;
    message = out.message ?? 'Classroom generation failed';
    error =
      out.error ??
      (state === 'expired'
        ? 'Job expired (worker may have restarted)'
        : 'Classroom generation failed');
  }

  return {
    jobId: job.id,
    status,
    step,
    progress,
    message,
    pollIntervalMs: 5000,
    scenesGenerated,
    ...(totalScenes !== undefined ? { totalScenes } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(error !== undefined ? { error } : {}),
    done: status === 'succeeded' || status === 'failed',
  };
}
