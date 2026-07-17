/**
 * Per-user fixed-window rate limiter (short-window abuse protection).
 *
 * Distinct from the monthly billing quota in quota.ts (a Postgres usage aggregate):
 * this is a per-minute Redis INCR throttle that protects upstream LLM keys from
 * burst abuse. Fail-open: any Redis error returns null so a Redis blip cannot
 * block generation.
 */
import IORedis from 'ioredis';
import type { NextResponse } from 'next/server';
import { apiError, API_ERROR_CODES } from './api-response';

let _redis: IORedis | null = null;

/** Lazy ioredis singleton (connection opened on first check). */
function redis(): IORedis {
  if (_redis) return _redis;
  // ponytail: no REDIS_URL guard — fail-open path below returns null if unset.
  _redis = new IORedis(process.env.REDIS_URL ?? '', { lazyConnect: false });
  return _redis;
}

/**
 * Returns a 429 NextResponse if the user has exceeded RATE_LIMIT_PER_MINUTE
 * requests in the current 60s window, otherwise null. Never throws on Redis
 * hiccups — logs a warning and returns null (fail-open).
 */
export async function checkRateLimit(userId: string): Promise<NextResponse | null> {
  const limit = Number(process.env.RATE_LIMIT_PER_MINUTE) || 30;
  const key = 'ratelimit:' + userId + ':' + Math.floor(Date.now() / 1000 / 60);
  try {
    const count = await redis().incr(key);
    if (count === 1) await redis().expire(key, 60);
    if (count > limit) {
      return apiError(
        API_ERROR_CODES.RATE_LIMITED,
        429,
        `Rate limit exceeded (${limit}/min). Try again shortly.`,
      );
    }
    return null;
  } catch (err) {
    // Fail-open: a Redis outage must NOT block generation.
    console.warn('[rate-limit] Redis error, allowing request:', err);
    return null;
  }
}
