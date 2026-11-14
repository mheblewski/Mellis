import { Body, Controller, HttpCode, Inject, Injectable, Param, Post, UseFilters, UseGuards } from '@nestjs/common';
import type { Pool } from 'pg';
import { ForbiddenError, ValidationError } from '@shared/errors/app-error';
import { DATABASE_POOL } from '@infra/db/database.tokens';
import { PostgresGlucoMindRepository } from '@infra/db/postgres-glucomind.repository';
import { PostgresSettingsWhatIfRepository } from '@infra/db/postgres-settings-whatif.repository';
import { resolveInsulinCurve } from '@modules/glucose-forecast/application/insulin-curve';
import { isChatSimulationEnabled } from '@modules/chat-simulation/application/simulation-flag';
import { isSettingsReplayEnabled, settingsReplayCheckDate } from '@modules/settings-whatif/application/settings-replay-intent';
import { settingsReplayCardOffThread } from '@modules/settings-whatif/application/settings-replay-thread';
import type { ReplaySetting, SettingChange } from '@modules/settings-whatif/application/settings-replay';
import { PatientPermissionGuard } from '../auth/patient-permission.guard';
import { BearerPrincipalGuard, RequestPrincipal } from '../auth/bearer-principal.guard';
import { Principal } from '../auth/principal.decorator';
import { ProblemDetailsFilter } from '../common/problem.filter';

const SETTINGS: ReplaySetting[] = ['BASAL', 'TARGET', 'ISF', 'ICR'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The change a card's −/+ sends; anything else is refused. */
export function parseSettingChange(body: unknown): SettingChange {
  const record = (body ?? {}) as Record<string, unknown>;
  const setting = record.setting as ReplaySetting;
  if (!SETTINGS.includes(setting)) throw new ValidationError('setting must be BASAL, TARGET, ISF or ICR');
  if (typeof record.from !== 'string' || !TIME.test(record.from) || typeof record.to !== 'string' || !TIME.test(record.to)) throw new ValidationError('from and to must be HH:MM');
  const value = Number(record.value);
  if (!Number.isFinite(value)) throw new ValidationError('value must be a number');
  return { setting, from: record.from, to: record.to, value };
}

/**
 * The settings replay card for one named change (settings-replay-card.v1): the −/+ on a card in the chat or in
 * "Pod lupą" asks for the same change with another value and gets the card counted again. Behind
 * SETTINGS_REPLAY_ENABLED; members with chats and meals, as the chat itself.
 */
@Injectable()
export class SettingsReplayApi {
  private readonly store: PostgresSettingsWhatIfRepository;

  constructor(
    @Inject(PostgresGlucoMindRepository) private readonly repository: PostgresGlucoMindRepository,
    @Inject(DATABASE_POOL) pool: Pool,
  ) {
    this.store = new PostgresSettingsWhatIfRepository(pool);
  }

  async card(principal: RequestPrincipal, patientId: string, body: unknown): Promise<Record<string, unknown>> {
    // The chat simulation's cards are recounted here too (−/+ under the card).
    if (!isSettingsReplayEnabled(process.env) && !isChatSimulationEnabled(process.env)) throw new ForbiddenError('Settings replay is off on this server');
    const scopes = await this.repository.getMemberScopes(principal.user_id, patientId);
    if (!scopes) throw new ForbiddenError('Not a member of this patient');
    const change = parseSettingChange(body);
    const now = new Date();
    const therapy = await this.repository.getTherapyProfileAt(patientId, now.toISOString());
    const insulinType = await this.repository.getLoopInsulinType(patientId, new Date(now.getTime() - 7 * 24 * 3_600_000).toISOString()).catch(() => null);
    const data = await this.store.loadIcrWhatIfData({
      patientId,
      endIso: now.toISOString(),
      days: 31,
      defaultTimeZone: therapy.timezone || 'Europe/Warsaw',
      peakMinutes: resolveInsulinCurve({ loop_insulin_type: insulinType }).peak_minutes,
      withTrioCycles: true,
    });
    const result = await settingsReplayCardOffThread({ kind: 'SETTINGS_REPLAY_CARD', data, change, check_date: settingsReplayCheckDate() });
    return result.status === 'OK' ? { status: 'OK', card: result.card } : { status: result.status, card: null };
  }
}

@Controller('/v1/patients/:patientId')
@UseGuards(BearerPrincipalGuard, PatientPermissionGuard)
@UseFilters(ProblemDetailsFilter)
export class SettingsReplayController {
  constructor(@Inject(SettingsReplayApi) private readonly api: SettingsReplayApi) {}

  @Post('settings-replay')
  @HttpCode(200)
  async card(@Principal() principal: RequestPrincipal, @Param('patientId') patientId: string, @Body() body: unknown): Promise<Record<string, unknown>> {
    return this.api.card(principal, patientId, body);
  }
}
