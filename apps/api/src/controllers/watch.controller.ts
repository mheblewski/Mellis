import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Post, Put, Query, Res, UseFilters, UseGuards } from '@nestjs/common';
import { WatchService, type WatchDeviceCreated } from '../application/watch.service';
import { BearerPrincipalGuard, RequestPrincipal } from '../auth/bearer-principal.guard';
import { Principal } from '../auth/principal.decorator';
import { ProblemDetailsFilter } from '../common/problem.filter';
import { parseWatchGlanceHours, type WatchGlance } from '@modules/watch/domain/watch-glance';

/** The caregiver's side of the watch devices (watch-glance.v1), signed in like every other /v1/me route. */
@Controller('/v1/me')
@UseGuards(BearerPrincipalGuard)
@UseFilters(ProblemDetailsFilter)
export class MeWatchController {
  constructor(@Inject(WatchService) private readonly watch: WatchService) {}

  /**
   * The phone's paired Apple Watch: { "device"?: label, "patient_ids"?: [1–4 ids] } →
   * 201 { "token": "gmw_…", "device": {…}, "patients": [{ "id", "name" }] }. 422 a malformed body, 403 a patient of
   * someone else.
   */
  @Post('watch-devices')
  @HttpCode(201)
  async createDevice(@Principal() principal: RequestPrincipal, @Body() body: unknown): Promise<WatchDeviceCreated> {
    return this.watch.createDevice(principal, body ?? {});
  }

  /** Revokes the watch's token. 204; 404 for an unknown device or another caregiver's. */
  @Delete('watch-devices/:id')
  @HttpCode(204)
  async revokeDevice(@Principal() principal: RequestPrincipal, @Param('id') id: string): Promise<void> {
    await this.watch.revokeDevice(principal, id);
  }
}

/** The watch's side: no user sign-in, only a watch token (the user guard refuses it everywhere else). */
@Controller('/v1/watch')
@UseFilters(ProblemDetailsFilter)
export class WatchController {
  constructor(@Inject(WatchService) private readonly watch: WatchService) {}

  /** Authorization: Bearer gmw_… → { "now", "p": [{ "id", "n", "v", "dir", "dl", "at", "iob", "cob" }] };
   *  ?hours=1–3 adds "r": [[epoch s, mg/dL], …] per patient. */
  @Get('glance')
  async glance(
    @Headers('authorization') authorization: string | undefined,
    @Query('hours') hours: string | undefined,
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): unknown },
  ): Promise<WatchGlance> {
    const glance = await this.watch.glance(authorization, new Date(), parseWatchGlanceHours(hours));
    response.setHeader('Cache-Control', 'no-store');
    return glance;
  }

  /**
   * The complications (widget-push.v1), Authorization: Bearer gmw_… of that watch:
   * { "token": hex, "topic": bundle id, "environment": "sandbox" | "production", "platform": "watchos" | "ios" } → 204.
   * The patients are the watch device's. 401 a missing or revoked token, 422 a bad body.
   */
  @Put('widget-push-token')
  @HttpCode(204)
  async setWidgetPushToken(@Headers('authorization') authorization: string | undefined, @Body() body: unknown): Promise<void> {
    await this.watch.setWidgetPushToken(authorization, body ?? {});
  }
}
