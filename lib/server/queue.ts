/**
 * BullMQ + Redis queue for classroom generation.
 *
 * Why BullMQ (not pg-boss): native `job.updateProgress(obj)` + `job.progress` give
 * smooth mid-flight progress (step / progress / scenesGenerated advancing live) that
 * pg-boss has no equivalent for. Redis is the natural home for high-frequency progress
 * writes. Lazy `getQueue()` so importing this module (the POST route at build time)
 * does NOT open a Redis connection.
 *
 * Exports `getJobStatus` + `isValidClassroomJobId` keep the GET poll contract stable.
 */
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import type { GenerateClassroomInput } from '@/lib/server/classroom-generation';

export const CLASSROOM_QUEUE = 'classroom-generation';

/** Live progress payload the worker streams via job.updateProgress(). */
export interface JobProgress {
  step?: string;
  progress?: number;
  message?: string;
  scenesGenerated?: number;
  totalScenes?: number;
}

/** Terminal payload the worker returns as the job's returnvalue. */
export interface JobTerminal extends JobProgress {
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

export interface ClassroomJobData {
  input: GenerateClassroomInput;
  baseUrl: string;
  userId: string;
}

export function isValidClassroomJobId(jobId: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(jobId);
}

let _queue: Queue | null = null;

/** Lazy singleton Queue (creates the IORedis connection on first use). */
export function getQueue(): Queue {
  if (_queue) return _queue;
  if (!process.env.REDIS_URL) throw new Error('REDIS_URL is not set');
  const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  _queue = new Queue(CLASSROOM_QUEUE, { connection });
  return _queue;
}

/**
 * Enqueue a classroom generation job. Returns the BullMQ job id (uuid). attempts:1 +
 * no retry — generation writes media/audio/JSON and is NOT idempotent. removeOnComplete/
 * removeOnFail keep the queue bounded while leaving enough history for polling.
 */
export async function enqueueClassroomJob(
  input: GenerateClassroomInput,
  baseUrl: string,
  userId: string,
): Promise<string> {
  const job = await getQueue().add('generate', { input, baseUrl, userId } satisfies ClassroomJobData, {
    attempts: 1,
    removeOnComplete: 1000,
    removeOnFail: 5000,
  });
  if (!job?.id) throw new Error('Failed to enqueue classroom generation job');
  return job.id;
}

/**
 * Map a BullMQ job onto the poll response shape. Reads live `job.progress` (the
 * JobProgress object the worker streams) for running jobs, and `job.returnvalue`
 * (JobTerminal) on completion. Returns null when the job no longer exists (caller 404s).
 */
export async function getJobStatus(jobId: string): Promise<JobPollResponse | null> {
  const job = await getQueue().getJob(jobId);
  if (!job) return null;

  const state: string = await job.getState();
  const p: JobProgress =
    job.progress && typeof job.progress === 'object' ? (job.progress as JobProgress) : {};
  const rv: JobTerminal | undefined =
    job.returnvalue && typeof job.returnvalue === 'object'
      ? (job.returnvalue as JobTerminal)
      : undefined;

  let status: JobPollResponse['status'];
  let step: string;
  let progress: number;
  let message: string;
  let scenesGenerated = p.scenesGenerated ?? 0;
  let totalScenes = p.totalScenes;
  let result: JobPollResponse['result'];
  let error: string | undefined;

  if (state === 'completed') {
    status = 'succeeded';
    step = rv?.step ?? 'completed';
    progress = 100;
    message = rv?.message ?? 'Classroom generation completed';
    scenesGenerated = rv?.scenesGenerated ?? p.scenesGenerated ?? 0;
    totalScenes = rv?.totalScenes ?? p.totalScenes;
    result = rv?.result;
  } else if (state === 'failed') {
    status = 'failed';
    step = 'failed';
    progress = p.progress ?? 0;
    message = p.message ?? 'Classroom generation failed';
    error = job.failedReason ?? 'Classroom generation failed';
  } else if (state === 'active') {
    status = 'running';
    step = p.step ?? 'running';
    progress = p.progress ?? 0;
    message = p.message ?? 'Classroom generation running';
  } else {
    // waiting | delayed | prioritized | ...
    status = 'queued';
    step = 'queued';
    progress = 0;
    message = 'Classroom generation job queued';
    scenesGenerated = 0;
  }

  return {
    jobId: job.id!,
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
