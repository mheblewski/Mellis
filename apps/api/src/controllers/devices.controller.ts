import { Body, Controller, HttpCode, Inject, Post, UseFilters } from '@nestjs/common';
import { ApiService } from '../application/api.service';
import { ProblemDetailsFilter } from '../common/problem.filter';

/**
 * POST /v1/devices/release is public on purpose (audit 2026-10-26): a phone whose sign-out could not reach the server
 * releases its rows later, after the session is gone. { "platform": "ios", "push_token": string, "release_secret":
 * string }; the secret is the phone's own (only its hash is stored at registration). 204 whether anything matched.
 */
@Controller('/v1/devices')
@UseFilters(ProblemDetailsFilter)
export class DevicesController {
  constructor(@Inject(ApiService) private readonly apiService: ApiService) {}

  @Post('release')
  @HttpCode(204)
  async releaseDevice(@Body() body: unknown): Promise<void> {
    await this.apiService.releaseDevice(body ?? {});
  }
}
