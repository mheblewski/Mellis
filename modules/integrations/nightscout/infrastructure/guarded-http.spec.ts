import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { guardedGet, isPrivateAddress, publicOnlyLookup } from './guarded-http';
import { guardsNightscoutHost } from '../application/nightscout-connection';

describe('guarded Nightscout requests (sharing audit #7)', () => {
  it('knows private, loopback, link-local, CGNAT, unique-local and mapped addresses', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ['8.8.8.8', '151.101.1.1', '2a00:1450:4001:82a::200e']) expect(isPrivateAddress(address), address).toBe(false);
  });

  it('refuses a host that resolves to a private address, at connect time', async () => {
    await new Promise<void>((resolve) => publicOnlyLookup('localhost', { all: true }, (error) => {
      expect(error?.message).toBe('PRIVATE_ADDRESS');
      resolve();
    }));
    await expect(guardedGet(new URL('http://localhost:9/api'), {})).rejects.toMatchObject({ reason: 'PRIVATE_ADDRESS' });
    await expect(guardedGet(new URL('http://127.0.0.1:9/api'), {})).rejects.toMatchObject({ reason: 'PRIVATE_ADDRESS' });
    await expect(guardedGet(new URL('http://[::1]:9/api'), {})).rejects.toMatchObject({ reason: 'PRIVATE_ADDRESS' });
  });

  it('guards every public host and skips only private hosts listed on purpose', () => {
    expect(guardsNightscoutHost('https://ns.example', {})).toBe(true);
    expect(guardsNightscoutHost('https://ns.example', { NIGHTSCOUT_ALLOWED_HOSTS: 'ns.example' })).toBe(true);
    expect(guardsNightscoutHost('http://localhost:4317', { NIGHTSCOUT_ALLOWED_HOSTS: 'localhost' })).toBe(false);
    expect(guardsNightscoutHost('http://localhost:4317', {})).toBe(true);
  });

  it('does not follow redirects and caps the body (a loopback server, its address check replaced for the test)', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://169.254.169.254/' }); res.end(); return; }
      res.writeHead(200); res.end(req.url === '/big' ? 'x'.repeat(4096) : '{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const base = `http://testhost:${(server.address() as AddressInfo).port}`;
    const loopback = ((_host: string, opts: any, cb: any) => (opts?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4))) as any;
    await expect(guardedGet(new URL(`${base}/redirect`), {}, { unsafeLookupForTests: loopback })).rejects.toMatchObject({ reason: 'REDIRECT', statusCode: 302 });
    await expect(guardedGet(new URL(`${base}/big`), {}, { unsafeLookupForTests: loopback, maxBytes: 1024 })).rejects.toMatchObject({ reason: 'TOO_LARGE' });
    await expect(guardedGet(new URL(`${base}/ok`), {}, { unsafeLookupForTests: loopback })).resolves.toEqual({ status: 200, body: '{"ok":true}' });
    server.close();
  });
});
