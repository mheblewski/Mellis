import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { assertForecastCalibrationEnv } from '@modules/glucose-forecast/application/forecast-calibration';
import { WorkerAppModule } from './app.module';
import { installGracefulShutdown } from './shutdown';

async function bootstrap(): Promise<void> {
  // FORECAST_CALIBRATION: a typo stops the worker instead of silently using another forecast.
  assertForecastCalibrationEnv();
  const app = await NestFactory.createApplicationContext(WorkerAppModule, {
    logger: ['error', 'warn', 'log'],
  });

  installGracefulShutdown(app);
}

void bootstrap();
