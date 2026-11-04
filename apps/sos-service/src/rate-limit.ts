// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Minimal in-process sliding-window rate limiter for the public SOS surfaces.
 *
 * This protects the demo shell and expensive provider/stream routes against a
 * single client. Production edge rate limiting still belongs in nginx; this is
 * defence in depth for the service container. State is per process and is not a
 * data store.
 */
import type { NextFunction, Request, Response } from 'express';

export interface RateLimitOptions {
  windowMs?: number;
  max?: number;
  key?: (req: Request) => string;
  name?: string;
  now?: () => number;
}

interface Bucket {
  hits: number[];
}

export interface RateLimiter {
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  reset: () => void;
  size: () => number;
}

function clientKey(req: Request): string {
  const forwarded = req.header('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() || req.ip || req.socket?.remoteAddress || 'unknown';
  return ip;
}

export function createRateLimiter(options: RateLimitOptions = {}): RateLimiter {
  const windowMs = Math.max(1_000, options.windowMs ?? 60_000);
  const max = Math.max(1, options.max ?? 120);
  const keyOf = options.key ?? clientKey;
  const name = options.name ?? 'sos';
  const now = options.now ?? Date.now;
  const buckets = new Map<string, Bucket>();

  function middleware(req: Request, res: Response, next: NextFunction): void {
    if (process.env.RATE_LIMIT_DISABLED === 'true') return next();
    const key = `${name}:${keyOf(req)}`;
    const current = now();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { hits: [] };
      buckets.set(key, bucket);
    }
    bucket.hits = bucket.hits.filter((hit) => current - hit < windowMs);
    if (bucket.hits.length >= max) {
      const retryAfter = Math.max(1, Math.ceil((windowMs - (current - bucket.hits[0])) / 1000));
      res.setHeader('retry-after', String(retryAfter));
      res.status(429).json({ error: 'rate_limited', retry_after_seconds: retryAfter, limit: max, window_seconds: Math.ceil(windowMs / 1000) });
      return;
    }
    bucket.hits.push(current);
    // Opportunistic cleanup keeps the map bounded under many distinct clients.
    if (buckets.size > 10_000) {
      for (const [candidate, value] of buckets) {
        if (value.hits.every((hit) => current - hit >= windowMs)) buckets.delete(candidate);
      }
    }
    res.setHeader('x-ratelimit-limit', String(max));
    res.setHeader('x-ratelimit-remaining', String(Math.max(0, max - bucket.hits.length)));
    next();
  }

  return {
    middleware,
    reset: () => buckets.clear(),
    size: () => buckets.size,
  };
}

function envInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Route-scoped limiters wired in server.ts. */
export const rateLimiters = {
  auth: createRateLimiter({ name: 'auth', windowMs: envInt('RATE_LIMIT_AUTH_WINDOW_MS', 60_000), max: envInt('RATE_LIMIT_AUTH_MAX', 60) }),
  stream: createRateLimiter({ name: 'stream', windowMs: envInt('RATE_LIMIT_STREAM_WINDOW_MS', 60_000), max: envInt('RATE_LIMIT_STREAM_MAX', 30) }),
  geo: createRateLimiter({ name: 'geo', windowMs: envInt('RATE_LIMIT_GEO_WINDOW_MS', 60_000), max: envInt('RATE_LIMIT_GEO_MAX', 120) }),
  ai: createRateLimiter({ name: 'ai', windowMs: envInt('RATE_LIMIT_AI_WINDOW_MS', 60_000), max: envInt('RATE_LIMIT_AI_MAX', 30) }),
};
