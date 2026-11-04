import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from '@shared/errors/app-error';
import { DATABASE_POOL } from '@infra/db/database.tokens';
import { PostgresGlucoMindRepository } from '@infra/db/postgres-glucomind.repository';
import { PostgresWatchDeviceRepository, type WatchDeviceRow } from '@infra/db/postgres-watch-device.repository';
import { PostgresWidgetPushRepository, type WidgetPushEnvironment, type WidgetPushPlatform } from '@infra/db/postgres-widget-push.repository';
import { DashboardAssembler } from '@modules/dashboard/application/dashboard-assembler';
import type { DashboardResponse } from '@modules/dashboard/application/dashboard-snapshot';
import {
  generateWatchToken,
  isWatchTokenShape,
  normalizeWatchDeviceLabel,
  sha256Hex,
  WATCH_MAX_PATIENTS,
  watchGlancePatient,
  type WatchGlance,
} from '@modules/watch/domain/watch-glance';
import type { RequestPrincipal } from '../auth/bearer-principal.guard';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WatchDeviceView {
  id: string;
  device: string | null;
  patient_ids: string[];
  created_at: string;
  last_used_at: string | null;
}

export interface WatchDeviceCreated {
  token: string;
  device: WatchDeviceView;
  patients: Array<{ id: string; name: string }>;
}

/**
 * Apple Watch devices and their read-only watch tokens (gmw_, watch-glance.v1). The phone creates the device and hands
 * the token to its paired watch, which reads the compact glance every few minutes and registers its complications'
 * WidgetKit push token. A watch token works only on /v1/watch/* (BearerPrincipalGuard refuses it everywhere else).
 */
@Injectable()
export class WatchService {
  private readonly logger = new Logger(WatchService.name);
  private devices: PostgresWatchDeviceRepository;
  private widgetPush: Pick<PostgresWidgetPushRepository, 'upsert'>;
  private dashboard: (patientId: string, now: Date) => Promise<Pick<DashboardResponse, 'glucose' | 'loop'>>;

  constructor(
    @Inject(PostgresGlucoMindRepository) private readonly repository: PostgresGlucoMindRepository,
    @Inject(DATABASE_POOL) pool: Pool,
  ) {
    this.devices = new PostgresWatchDeviceRepository(pool);
    this.widgetPush = new PostgresWidgetPushRepository(pool);
    // The Dashboard tab's source (live Nightscout first), like the Live Activity and widget pushes.
    const dashboards = DashboardAssembler.fromEnv(pool, repository);
    this.dashboard = (patientId, now) => dashboards.dashboard(patientId, now);
  }

  /**
   * POST /v1/me/watch-devices: { device?, patient_ids? } → a new watch token shown once, which the phone hands to its
   * paired watch. The caregiver's earlier active device with the same label is revoked (the phone lost it or replaces it).
   */
  async createDevice(principal: RequestPrincipal, body: unknown, now: Date = new Date()): Promise<WatchDeviceCreated> {
    const input = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    if (input.device !== undefined && input.device !== null && typeof input.device !== 'string') throw new ValidationError('device must be text');
    const patientIds = await this.choosePatientIds(principal, input.patient_ids);
    const token = generateWatchToken();
    const device = await this.devices.createWatchDevice({
      userId: principal.user_id,
      device: normalizeWatchDeviceLabel(input.device),
      patientIds,
      tokenHash: sha256Hex(token),
      now,
    });
    this.logger.log(`watch.device_created device=${device.id} patients=${patientIds.length}`);
    return { token, device: deviceView(device), patients: await this.orderedReadablePatients(device) };
  }

  /**
   * PUT /v1/watch/widget-push-token (watch token): { token (hex), topic (bundle id without the suffix), environment,
   * platform } of its complications (widget-push.v1). The patients are the watch device's, as far as its caregiver can
   * still see them. Upserted by token.
   */
  async setWidgetPushToken(authorization: string | string[] | undefined, body: unknown, now: Date = new Date()): Promise<void> {
    const device = await this.deviceFor(authorization);
    const input = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const token = normalizeWidgetPushToken(input.token);
    if (!token) throw new ValidationError('token must be a hex string');
    const topic = typeof input.topic === 'string' ? input.topic.trim() : '';
    if (!BUNDLE_ID_PATTERN.test(topic) || topic.length > 155 || topic.endsWith('.push-type.widgets')) {
      throw new ValidationError('topic must be a bundle id (without .push-type.widgets)');
    }
    if (input.environment !== 'sandbox' && input.environment !== 'production') throw new ValidationError('environment must be sandbox or production');
    if (input.platform !== 'watchos' && input.platform !== 'ios') throw new ValidationError('platform must be watchos or ios');
    const patients = await this.orderedReadablePatients(device);
    if (patients.length === 0) throw new ForbiddenError('Patient access denied');
    await this.widgetPush.upsert({
      token,
      userId: device.user_id,
      watchDeviceId: device.id,
      topic,
      environment: input.environment as WidgetPushEnvironment,
      platform: input.platform as WidgetPushPlatform,
      patientIds: patients.map((patient) => patient.id.toLowerCase()),
      now,
    });
  }

  /** GET /v1/watch/glance: the device's patients' latest reading and IOB/COB; ?hours=1–3 adds each patient's readings of
   *  those hours (the complication's chart). */
  async glance(authorization: string | string[] | undefined, now: Date = new Date(), historyHours: number | null = null): Promise<WatchGlance> {
    const device = await this.deviceFor(authorization);
    // The token's caregiver may have lost a patient since: such patients are left out.
    const patients = await this.orderedReadablePatients(device);
    const entries = await Promise.all(patients.map(async (patient) => {
      const dashboard = await this.dashboard(patient.id, now).catch((error: unknown) => {
        this.logger.warn(`watch.glance dashboard failed device=${device.id}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      return watchGlancePatient(patient.id, patient.name, dashboard, { historyHours, now });
    }));
    await this.devices.touchDevice(device.id, now).catch(() => undefined);
    return { now: Math.floor(now.getTime() / 1000), p: entries };
  }

  /** DELETE /v1/me/watch-devices/:id: revokes the caller's own watch and forgets its push tokens; anything else is 404. */
  async revokeDevice(principal: RequestPrincipal, id: string, now: Date = new Date()): Promise<void> {
    if (!UUID_PATTERN.test(id) || !(await this.devices.revokeDevice(id.toLowerCase(), principal.user_id, now))) {
      throw new NotFoundError('Watch device not found');
    }
  }

  /** The chosen patients (each one this caregiver can see), else their first patients in the list order. */
  private async choosePatientIds(principal: RequestPrincipal, raw: unknown): Promise<string[]> {
    const max = WATCH_MAX_PATIENTS;
    if (raw === undefined || raw === null) {
      const patients = await this.repository.listAccessiblePatients(principal.user_id);
      const listed = patients.map((patient) => patient.patient_id.toLowerCase());
      const readable = new Set((await this.devices.readablePatients(principal.user_id, listed)).map((patient) => patient.id.toLowerCase()));
      const ids = listed.filter((id) => readable.has(id)).slice(0, max);
      if (ids.length === 0) throw new ValidationError('No patients to show on the watch');
      return ids;
    }
    if (!Array.isArray(raw) || raw.length < 1 || raw.some((id) => typeof id !== 'string' || !UUID_PATTERN.test(id.trim()))) {
      throw new ValidationError(`patient_ids must hold 1 to ${max} patient ids`);
    }
    const ids = [...new Set((raw as string[]).map((id) => id.trim().toLowerCase()))];
    if (ids.length > max) throw new ValidationError(`patient_ids must hold 1 to ${max} patient ids`);
    const readable = new Set((await this.devices.readablePatients(principal.user_id, ids)).map((patient) => patient.id.toLowerCase()));
    if (ids.some((id) => !readable.has(id))) throw new ForbiddenError('Patient access denied');
    return ids;
  }

  private async deviceFor(authorization: string | string[] | undefined): Promise<WatchDeviceRow> {
    const header = Array.isArray(authorization) ? authorization[0] : authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (!isWatchTokenShape(token)) throw new UnauthorizedError('Missing or invalid watch token');
    const device = await this.devices.findActiveDeviceByTokenHash(sha256Hex(token));
    if (!device) throw new UnauthorizedError('Missing or invalid watch token');
    return device;
  }

  /** The device's patients in their chosen order, only those its caregiver can still read. */
  private async orderedReadablePatients(device: WatchDeviceRow): Promise<Array<{ id: string; name: string }>> {
    const readable = await this.devices.readablePatients(device.user_id, device.patient_ids);
    const byId = new Map(readable.map((patient) => [patient.id.toLowerCase(), patient]));
    return device.patient_ids.flatMap((id) => {
      const patient = byId.get(id.toLowerCase());
      return patient ? [{ id: patient.id, name: patient.name }] : [];
    });
  }
}

function deviceView(row: WatchDeviceRow): WatchDeviceView {
  return {
    id: row.id,
    device: row.device,
    patient_ids: row.patient_ids,
    created_at: new Date(row.created_at).toISOString(),
    last_used_at: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
  };
}

/** An app's bundle id: two or more dot-separated parts of letters, digits and hyphens. */
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/** APNs tokens are hex (64 characters today); lower-cased so a token registered twice is one row. */
export function normalizeWidgetPushToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const token = value.trim().toLowerCase();
  return /^[0-9a-f]{16,512}$/.test(token) && token.length % 2 === 0 ? token : null;
}
