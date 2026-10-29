import { Body, Controller, Get, HttpCode, Inject, Post, Put, UseFilters, UseGuards } from '@nestjs/common';
import type { UserAiPreferences } from '@shared/primitives/user-ai-preferences';
import { ApiService } from '../application/api.service';
import { BearerPrincipalGuard, RequestPrincipal } from '../auth/bearer-principal.guard';
import { Principal } from '../auth/principal.decorator';
import { ProblemDetailsFilter } from '../common/problem.filter';

@Controller('/v1/me')
@UseGuards(BearerPrincipalGuard)
@UseFilters(ProblemDetailsFilter)
export class MeController {
  constructor(@Inject(ApiService) private readonly apiService: ApiService) {}

  @Get('patients')
  async listAccessiblePatients(
    @Principal() principal: RequestPrincipal,
  ): Promise<{ user_id: string; user_display_name: string | null; patients: Array<{ patient_id: string; display_name: string; birth_year: number | null }> }> {
    return this.apiService.listAccessiblePatients(principal);
  }

  /** "Moje instrukcje dla AI" (Settings): who this user is and their wishes for the AI. */
  @Get('ai-preferences')
  async getAiPreferences(@Principal() principal: RequestPrincipal): Promise<UserAiPreferences> {
    return this.apiService.getUserAiPreferences(principal);
  }

  @Put('ai-preferences')
  async setAiPreferences(@Principal() principal: RequestPrincipal, @Body() body: unknown): Promise<UserAiPreferences> {
    return this.apiService.setUserAiPreferences(principal, body ?? {});
  }

  /**
   * Sign-out on this phone: { "push_token": string, "platform": "ios" }. Every device row with this token is
   * deactivated for the patients this caregiver can access, so the phone stops receiving their pushes. 204.
   */
  @Post('devices/sign-out')
  @HttpCode(204)
  async signOutDevice(@Principal() principal: RequestPrincipal, @Body() body: unknown): Promise<void> {
    await this.apiService.signOutDevice(principal, body ?? {});
  }
}
