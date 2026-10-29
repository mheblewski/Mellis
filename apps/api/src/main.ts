import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ApiAppModule } from './app.module';
import { resolveApiListenOptions } from './listen-options';

async function bootstrap(): Promise<void> {
  // Own body parsers: meal photos arrive as base64 JSON (up to 4 MB of JPEG), above Express's 100 kB default.
  const app = await NestFactory.create<NestExpressApplication>(ApiAppModule, { cors: true, bodyParser: false });
  app.useBodyParser('json', { limit: '6mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '100kb' });

  const { port, host } = resolveApiListenOptions(process.env);
  if (host) {
    await app.listen(port, host);
  } else {
    await app.listen(port);
  }
}

void bootstrap();