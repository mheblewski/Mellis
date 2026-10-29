import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'net';
import { describe, expect, it } from 'vitest';
import { resolveApiListenOptions } from './listen-options';

// An empty Nest module: no database, no controllers. Port 0 lets the OS pick a free port.
@Module({})
class EmptyModule {}

async function boundAddress(env: NodeJS.ProcessEnv): Promise<string> {
  const { host } = resolveApiListenOptions({ ...env, API_PORT: '0' });
  const app = await NestFactory.create(EmptyModule, { logger: false });
  try {
    if (host) {
      await app.listen(0, host);
    } else {
      await app.listen(0);
    }
    return (app.getHttpServer().address() as AddressInfo).address;
  } finally {
    await app.close();
  }
}

describe('resolveApiListenOptions', () => {
  it('keeps the previous behaviour when API_HOST is unset or empty', () => {
    expect(resolveApiListenOptions({})).toEqual({ port: 3000 });
    expect(resolveApiListenOptions({ API_PORT: '3001', API_HOST: '' })).toEqual({ port: 3001 });
    expect(resolveApiListenOptions({ API_HOST: '   ' })).toEqual({ port: 3000 });
  });

  it('listens on 3000 when API_PORT is empty, never on a random port', () => {
    expect(resolveApiListenOptions({ API_PORT: '' })).toEqual({ port: 3000 });
    expect(resolveApiListenOptions({ API_PORT: '   ' })).toEqual({ port: 3000 });
    expect(resolveApiListenOptions({ API_PORT: ' 8080 ' })).toEqual({ port: 8080 });
  });

  it('refuses an API_PORT that is not a port number', () => {
    for (const value of ['abc', '30a0', '-1', '3000.5', '70000']) {
      expect(() => resolveApiListenOptions({ API_PORT: value })).toThrow('API_PORT must be a port number (0-65535)');
    }
  });

  it('uses a trimmed API_HOST', () => {
    expect(resolveApiListenOptions({ API_PORT: '3000', API_HOST: ' 127.0.0.1 ' })).toEqual({ port: 3000, host: '127.0.0.1' });
  });

  it('rejects an API_HOST containing whitespace', () => {
    expect(() => resolveApiListenOptions({ API_HOST: '127.0.0.1 0.0.0.0' })).toThrow('API_HOST must be a single host name or address');
  });
});

describe('API listen address', () => {
  it('binds only to localhost when API_HOST=127.0.0.1', async () => {
    expect(await boundAddress({ API_HOST: '127.0.0.1' })).toBe('127.0.0.1');
  });

  it('still binds to every interface when API_HOST is unset', async () => {
    expect(['::', '0.0.0.0']).toContain(await boundAddress({}));
  });
});
