import type { NextFunction, Request, Response } from 'express';
import { toProblemDetails } from '@shared/errors/problem-details';
import { PROBLEM_CONTENT_TYPE } from './problem.filter';

/**
 * Per-IP rate limits of the public (unauthenticated) routes: setup, pairing, recovery, session challenges and the
 * device release. An in-memory token bucket per (rule, client IP): `burst` requests at once, refilled at `perMinute`.
 * One API process per server (deploy/docker-compose.yml), so memory is enough; a restart starts every bucket full.
 *
 * The client IP is Express's `req.ip`, which follows X-Forwarded-For only through trusted proxies (`trust proxy`,
 * set in http-setup.ts: loopback and private network addresses, i.e. Caddy, cloudflared or a host proxy).
 */
export interface RateLimitRule {
  readonly name: string;
  readonly method: string;
  /** Case-insensitive: Express routes /V1/PAIR to /v1/pair, so the limit must match it too. */
  readonly path: RegExp;
  readonly burst: number;
  readonly perMinute: number;
}

/**
 * The limits. Pairing and recovery codes have ~100 bits, so guessing is hopeless anyway: the limits keep abuse (and
 * the outgoing Nightscout / AI key checks of setup) cheap while the installers stay well inside them
 * (install-app.sh polls GET /v1/setup every 3 s; setup POSTs follow the person's typing).
 */
export const PUBLIC_RATE_LIMITS: readonly RateLimitRule[] = [
  { name: 'pairing', method: 'POST', path: /^\/v1\/(pair|setup\/recover)\/?$/i, burst: 5, perMinute: 10 },
  { name: 'setup', method: 'POST', path: /^\/v1\/setup\/[^/]+\/?$/i, burst: 10, perMinute: 10 },
  { name: 'setup-status', method: 'GET', path: /^\/v1\/setup\/?$/i, burst: 30, perMinute: 60 },
  { name: 'auth', method: 'POST', path: /^\/v1\/auth\/(challenge|session)\/?$/i, burst: 15, perMinute: 30 },
  { name: 'device-release', method: 'POST', path: /^\/v1\/devices\/release\/?$/i, burst: 5, perMinute: 10 },
];

/** At most this many buckets are kept; the least recently used one goes first (a fresh bucket is a full one). */
export const RATE_LIMIT_MAX_BUCKETS = 10_000;

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly maxBuckets = RATE_LIMIT_MAX_BUCKETS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes one token: { allowed: true } or the seconds until the next token. */
  take(rule: Pick<RateLimitRule, 'name' | 'burst' | 'perMinute'>, client: string): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const key = `${rule.name}|${client}`;
    const now = this.now();
    const ratePerMs = rule.perMinute / 60_000;
    const previous = this.buckets.get(key);
    const bucket = previous
      ? { tokens: Math.min(rule.burst, previous.tokens + (now - previous.updatedAt) * ratePerMs), updatedAt: now }
      : { tokens: rule.burst, updatedAt: now };
    // Re-inserted: Map order is the LRU order.
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    while (this.buckets.size > this.maxBuckets) {
      const oldest = this.buckets.keys().next().value as string;
      this.buckets.delete(oldest);
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / ratePerMs / 1000)) };
  }

  get size(): number {
    return this.buckets.size;
  }
}

/** Express middleware: 429 problem+json with Retry-After over the limit; other routes pass untouched. */
export function publicRateLimit(limiter = new TokenBucketLimiter(), rules: readonly RateLimitRule[] = PUBLIC_RATE_LIMITS) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const rule = rules.find((candidate) => candidate.method === request.method && candidate.path.test(request.path));
    if (!rule) {
      next();
      return;
    }
    const result = limiter.take(rule, request.ip ?? request.socket?.remoteAddress ?? 'unknown');
    if (result.allowed) {
      next();
      return;
    }
    response.setHeader('Retry-After', String(result.retryAfterSeconds));
    response.setHeader('Content-Type', PROBLEM_CONTENT_TYPE);
    response.status(429).json(toProblemDetails({
      type: 'https://api.glucomind.local/problems/rate_limited',
      title: `Too many requests: try again in ${result.retryAfterSeconds} s`,
      status: 429,
      code: 'RATE_LIMITED',
      instance: request.originalUrl,
    }));
  };
}
