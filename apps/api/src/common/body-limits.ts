import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { json, urlencoded } from 'express';
import { toProblemDetails } from '@shared/errors/problem-details';
import { PROBLEM_CONTENT_TYPE } from './problem.filter';

/** Every JSON body: at most 100 kB (Express's default), except the routes below. */
export const DEFAULT_JSON_LIMIT = '100kb';

/**
 * Routes whose JSON carries media or many encrypted packages, with their own limit:
 * - photos (main chat, meal chat): base64 JPEG of at most 4 MB (decodeJpegUpload) ≈ 5.4 MB of JSON;
 * - voice transcription: base64 .m4a of at most 3 MB (VOICE_MAX_BYTES) ≈ 4 MB of JSON;
 * - remote settings handoff: up to 10 packages of ≤ 16 KiB ciphertext in base64 plus signatures ≈ 230 kB.
 * Caddy's request_body max_size (deploy/Caddyfile, 8 MB) stays above the largest, so the API answers the size error.
 */
export const LARGE_JSON_ROUTES: ReadonlyArray<{ method: string; path: RegExp; limit: string }> = [
  { method: 'POST', path: /^\/v1\/patients\/[^/]+\/conversations\/[^/]+\/photos\/?$/i, limit: '6mb' },
  { method: 'POST', path: /^\/v1\/patients\/[^/]+\/meals\/[^/]+\/photos\/?$/i, limit: '6mb' },
  { method: 'POST', path: /^\/v1\/patients\/[^/]+\/transcriptions\/?$/i, limit: '6mb' },
  { method: 'POST', path: /^\/v1\/patients\/[^/]+\/remote-settings-handoffs\/?$/i, limit: '512kb' },
];

/**
 * JSON and urlencoded body parsing with the per-route limits. A parser error (too large, malformed JSON) answers in
 * the API's problem+json format here: body parsing runs before Nest, so the exception filter never sees it.
 */
export function bodyParsers(): RequestHandler {
  const defaultJson = json({ limit: DEFAULT_JSON_LIMIT });
  const largeJson = new Map(LARGE_JSON_ROUTES.map((route) => [route, json({ limit: route.limit })]));
  const form = urlencoded({ extended: true, limit: DEFAULT_JSON_LIMIT });
  return (request: Request, response: Response, next: NextFunction): void => {
    const route = LARGE_JSON_ROUTES.find((candidate) => candidate.method === request.method && candidate.path.test(request.path));
    const parser = (route && largeJson.get(route)) || defaultJson;
    parser(request, response, (jsonError?: unknown) => {
      if (jsonError) {
        sendParserError(request, response, jsonError);
        return;
      }
      form(request, response, (formError?: unknown) => {
        if (formError) sendParserError(request, response, formError);
        else next();
      });
    });
  };
}

function sendParserError(request: Request, response: Response, error: unknown): void {
  const raw = (error ?? {}) as { status?: unknown; statusCode?: unknown; type?: unknown };
  const status = typeof raw.status === 'number' ? raw.status : typeof raw.statusCode === 'number' ? raw.statusCode : 400;
  const [code, title] = status === 413
    ? ['PAYLOAD_TOO_LARGE', 'The request body is too large']
    : raw.type === 'entity.parse.failed'
      ? ['INVALID_JSON', 'The request body is not valid JSON']
      : status === 415
        ? ['UNSUPPORTED_MEDIA_TYPE', 'Unsupported request body encoding']
        : ['INVALID_BODY', 'The request body could not be read'];
  response.setHeader('Content-Type', PROBLEM_CONTENT_TYPE);
  response.status(status >= 400 && status < 500 ? status : 400).json(toProblemDetails({
    type: `https://api.glucomind.local/problems/${code.toLowerCase()}`,
    title,
    status: status >= 400 && status < 500 ? status : 400,
    code,
    instance: request.originalUrl,
  }));
}
