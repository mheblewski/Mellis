import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WorkerAppModule } from './app.module';
import { installGracefulShutdown } from './shutdown';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerAppModule, {
    logger: ['error', 'warn', 'log'],
  });

  installGracefulShutdown(app);
}

void bootstrap();
