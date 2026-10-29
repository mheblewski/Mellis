import { Controller, Get, Inject, Res, UseFilters, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { buildAppConfig, type AppConfigResponse } from '@modules/app-config/application/app-config';
import { sseFrame, sseOpening } from '@modules/live-updates/application/sse-event-writer';
import { ApiService } from '../application/api.service';
import { BearerPrincipalGuard } from '../auth/bearer-principal.guard';
import { ProblemDetailsFilter } from '../common/problem.filter';

/** GET /v1/app-config is public on purpose: the app reads it before sign-in, to show the update banner. No patient data. */
@Controller('/v1/app-config')
export class AppConfigController {
  constructor(@Inject(ApiService) private readonly apiService: Pick<ApiService, 'serverVoiceTranscriptionAvailable'>) {}

  @Get()
  getAppConfig(): AppConfigResponse {
    return buildAppConfig(process.env, { voice_transcription: this.apiService.serverVoiceTranscriptionAvailable?.() ?? false });
  }

  /**
   * Diagnostic for proxies in front of the API: ten ticks one second apart, the same framing and headers as the live
   * event stream, no data at all. Ticks arriving one by one mean a proxy passes event streams through; arriving all at
   * once after ten seconds mean it buffers them. Signed-in callers only: each request holds a connection and a timer
   * for ten seconds.
   */
  @Get('stream-check')
  @UseGuards(BearerPrincipalGuard)
  @UseFilters(ProblemDetailsFilter)
  streamCheck(@Res() response: Response): void {
    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-store, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    response.write(sseOpening(3000));
    let tick = 0;
    const timer = setInterval(() => {
      tick += 1;
      response.write(sseFrame('tick', { tick, at: new Date().toISOString() }));
      if (tick >= 10) {
        clearInterval(timer);
        response.end();
      }
    }, 1000);
    response.on('close', () => clearInterval(timer));
  }
}
