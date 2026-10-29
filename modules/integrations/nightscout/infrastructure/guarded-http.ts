import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

/**
 * GET for an address a person typed (a patient's Nightscout, sharing audit #7): the host's addresses are resolved and
 * checked when the connection is made (so DNS rebinding cannot swap in a private address after a check), redirects are
 * not followed and the body is capped. Errors say only that the request failed.
 */

export class GuardedRequestError extends Error {
  constructor(readonly reason: 'PRIVATE_ADDRESS' | 'REDIRECT' | 'TOO_LARGE' | 'TIMEOUT' | 'NETWORK', readonly statusCode: number | null = null) {
    super(`Nightscout request failed (${reason})`);
  }
}

export interface GuardedResponse {
  status: number;
  body: string;
}

/** Loopback, private, link-local, CGNAT, multicast, reserved, unique-local and IPv4-mapped forms of those. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0)
      || (a === 198 && (b === 18 || b === 19));
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith('ff') || lower.startsWith('64:ff9b:') || lower.startsWith('::ffff:');
  }
  return true;
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** dns.lookup that refuses any private address among the host's answers. */
export function publicOnlyLookup(hostname: string, options: { all?: boolean; family?: number } | number, callback: LookupCallback): void {
  const opts = typeof options === 'number' ? { family: options } : options ?? {};
  dnsLookup(hostname, { all: true, family: opts.family }, (error, addresses) => {
    if (error) return callback(error, '');
    const list = addresses as LookupAddress[];
    if (list.length === 0 || list.some((entry) => isPrivateAddress(entry.address))) {
      const refused = Object.assign(new Error('PRIVATE_ADDRESS'), { code: 'EPRIVATE' }) as NodeJS.ErrnoException;
      return callback(refused, '');
    }
    if (opts.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

/** `unsafeLookupForTests` replaces the address check (tests against a loopback server only). */
export function guardedGet(url: URL, headers: Record<string, string>, options: { timeoutMs?: number; maxBytes?: number; unsafeLookupForTests?: typeof publicOnlyLookup } = {}): Promise<GuardedResponse> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  if (!options.unsafeLookupForTests && isIP(url.hostname.replace(/^\[|\]$/g, '')) && isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ''))) {
    return Promise.reject(new GuardedRequestError('PRIVATE_ADDRESS'));
  }
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(url, { method: 'GET', headers, lookup: (options.unsafeLookupForTests ?? publicOnlyLookup) as never, timeout: timeoutMs }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        return reject(new GuardedRequestError('REDIRECT', status));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy();
          reject(new GuardedRequestError('TOO_LARGE', status));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => reject(new GuardedRequestError('NETWORK', status)));
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new GuardedRequestError('TIMEOUT'));
    });
    req.on('error', (error: NodeJS.ErrnoException) => reject(new GuardedRequestError(error.code === 'EPRIVATE' || error.message === 'PRIVATE_ADDRESS' ? 'PRIVATE_ADDRESS' : 'NETWORK')));
    req.end();
  });
}
