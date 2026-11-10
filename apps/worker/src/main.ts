import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DATABASE_POOL } from '@infra/db/database.tokens';
import { DiagnosticConsoleLogger } from '@modules/diagnostics/application/diagnostic-console-logger';
import { startDiagnosticEvents } from '@modules/diagnostics/infrastructure/start-diagnostic-events';
import { assertForecastCalibrationEnv } from '@modules/glucose-forecast/application/forecast-calibration';
import { WorkerAppModule } from './app.module';
import { installGracefulShutdown } from './shutdown';

async function bootstrap(): Promise<void> {
  // FORECAST_CALIBRATION: a typo stops the worker instead of silently using another forecast.
  assertForecastCalibrationEnv();
  const logger = new DiagnosticConsoleLogger();
  logger.setLogLevels(['error', 'warn', 'log']);
  const app = await NestFactory.createApplicationContext(WorkerAppModule, { logger });
  startDiagnosticEvents(app.get(DATABASE_POOL), 'worker');

  installGracefulShutdown(app);
}

void bootstrap();
