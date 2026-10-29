import type { NestExpressApplication } from '@nestjs/platform-express';
import { bodyParsers } from './common/body-limits';
import { publicRateLimit, TokenBucketLimiter } from './common/rate-limit';

/**
 * Who may name the client's IP (X-Forwarded-For): only a proxy whose own address is loopback or a private network
 * ("loopback, uniquelocal" = 127.0.0.0/8, ::1, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7). That is Caddy and
 * cloudflared on the compose network, or a proxy on the host reaching the published 127.0.0.1 port through Docker's
 * gateway (deploy/docker-compose.yml). Express walks X-Forwarded-For from the right and stops at the first address that
 * is not such a proxy, so a client cannot hide behind a forged header. A peer with a public address (a Mikrus
 * subdomain's proxy, a published port) is taken as the client itself: its users share one rate-limit bucket.
 * Caveat: a client on the same private network (a published port at home) is trusted too and can name any IP.
 */
export const TRUST_PROXY = 'loopback, uniquelocal';

/**
 * Everything of the HTTP stack before Nest's routes (main.ts, and the tests that check it): proxy trust, rate limits of
 * the public routes (before the body is read), body parsers with their per-route limits.
 */
export function configureHttp(app: NestExpressApplication, limiter = new TokenBucketLimiter()): void {
  app.set('trust proxy', TRUST_PROXY);
  app.use(publicRateLimit(limiter));
  app.use(bodyParsers());
}
