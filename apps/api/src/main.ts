import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { assertForecastCalibrationEnv } from '@modules/glucose-forecast/application/forecast-calibration';
import { ApiAppModule } from './app.module';
import { configureHttp } from './http-setup';
import { resolveApiListenOptions } from './listen-options';

async function bootstrap(): Promise<void> {
  // FORECAST_CALIBRATION (the Bolus chart reads it): a typo stops the API instead of silently using another forecast.
  assertForecastCalibrationEnv();
  // CORS off: only the native app (and curl in the installers) calls the API, never a web page of another origin; a
  // page the API serves itself would be same-origin. Without CORS headers browsers refuse cross-origin reads.
  // Own body parsers (http-setup.ts): 100 kB by default, more only on the photo / voice / handoff routes.
  const app = await NestFactory.create<NestExpressApplication>(ApiAppModule, { cors: false, bodyParser: false });
  configureHttp(app);

  const { port, host } = resolveApiListenOptions(process.env);
  if (host) {
    await app.listen(port, host);
  } else {
    await app.listen(port);
  }
}

void bootstrap();
