import { caregiverDeviceSql, memberAllowsSql, type MemberScope } from './sharing-access.sql';
import { TIR_VERY_LOW_BELOW_MGDL } from '@shared/primitives/glucose-rules';
import { sanitizeAnswerOptions } from '@modules/ai-gateway/application/answer-options';
import { sanitizeKnowledgeSources } from '@modules/ai-gateway/application/knowledge-answer-rules';
import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { DATABASE_POOL } from './database.tokens';
import { JobClaim, JobRecord } from '@modules/jobs/domain/job';
import { AiExecutionResult, AiTask, AICostEstimate, AIUsage } from '@modules/ai-gateway/domain/ai-gateway';
import { getQuestionAnswerOptions, pickLatestUsableEventScopedFact } from '@modules/context/application/hypo-question-candidates';
import {
  CANCELLABLE_ANALYSIS_JOB_TYPES,
  decideUserMessageCancellation,
  deriveConversationActivityStatus,
  parseUserMessageResponseState,
  type UserMessageCancellationOutcome,
} from '@modules/analysis/application/user-message-cancellation';
import { resolveConversationContext } from '@modules/context/application/conversation-context-resolver';
import { evaluateInvestigationDecision, getCandidateRegistry, InvestigationDecision, InvestigationEventFamily, InvestigationState } from '@modules/context/application/investigation-policy';
import type { RemoteControlSwitches } from '@modules/remote-commands/application/remote-control-access';
import { normalizeUserAiPreferences, type UserAiPreferences } from '@shared/primitives/user-ai-preferences';
import { resolveHomeTimeZone } from '@shared/primitives/home-time-zone';
import { APP_LINK_ORIGIN } from '@modules/notifications/domain/push-notification';

export interface AccessRow {
  user_id: string;
  patient_id: string;
  can_read_patient: boolean;
  can_write_patient: boolean;
}

export interface ResolveOrCreateUserByCognitoSubjectArgs {
  providerSubject: string;
  username: string | null;
  email: string | null;
  fullName: string | null;
}

/** Who authenticated the request (migration 061 allows the two local development modes besides Cognito). */
export type AuditProvider = 'COGNITO' | 'LOCAL_DEV' | 'LOCAL_TOKEN' | 'DEVICE_SECRET' | 'DEVICE' | 'SETUP_CODE' | 'RECOVERY_CODE' | 'SERVER_CLI';

/** An identity seen again within this interval is not written again (last_seen_at, sign-in audit row). */
export const AUTH_IDENTITY_TOUCH_INTERVAL_MINUTES = 15;

export interface AuthAuditEventInput {
  eventType: string;
  outcome: 'ALLOW' | 'DENY';
  provider: AuditProvider;
  providerSubject: string | null;
  userId: string | null;
  requestPath: string | null;
  metadata: Record<string, unknown>;
}

export interface PatientDeviceRow {
  id: string;
  patient_id: string;
  platform: 'ios';
  device_id: string;
  push_token: string;
  app_version: string | null;
  active: boolean;
  /** "Gotowa odpowiedź" in the phone's settings (migration 071); on by default. */
  answer_ready_push_enabled?: boolean;
  /** "Zbiornik insuliny" (migration 096); on by default. */
  reservoir_push_enabled?: boolean;
  /** The caregiver who registered the phone (migration 070); null for rows registered before it. */
  user_id?: string | null;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

export interface PushNotificationRow {
  id: string;
  dedupe_key: string;
  patient_id: string;
  conversation_id: string;
  question_id: string;
  notification_type: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  sent_at: string | null;
  last_error: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface InvestigationRow {
  id: string;
  patient_id: string;
  event_id: string | null;
  event_family: InvestigationEventFamily;
  state: InvestigationState;
  active_question_id: string | null;
  conversation_id: string;
  episode_id: string | null;
  trigger_id: string | null;
  last_decision: InvestigationDecision;
  last_decision_reason: string;
  created_at: string;
  updated_at: string;
}

export interface JobFinalizeResult {
  rowCount: number;
  ownershipLost: boolean;
}

/**
 * Remote bolus counts for a membership r only when switched on, granted by a current owner of the patient and confirmed
 * by the grantee (090_sharing_foundation.sql), for a member allowed the AI and meals.
 */
export const EFFECTIVE_REMOTE_COMMANDS_SQL = `(
  ${memberAllowsSql('r', 'care')}
  AND r.permissions->'remote_commands' = 'true'::jsonb
  AND r.remote_bolus_confirmed_at IS NOT NULL
  AND EXISTS (SELECT 1 FROM caregiver_relationships g
              WHERE g.patient_id = r.patient_id AND g.user_id = r.remote_bolus_granted_by AND g.is_owner)
)`;

const NIGHTSCOUT_STARVATION_AGE_SECONDS = 5 * 60;
const NIGHTSCOUT_STARVATION_AHEAD_THRESHOLD = 1000;
// Jobs a caregiver is waiting on in the app; they must not queue behind an import backlog.
const INTERACTIVE_JOB_TYPES = [
  'analysis.follow_up',
  'investigation.re_evaluate',
  'conversation.direct_response',
  'conversation.time_range_analysis',
  'meal.chat_reply',
  'meal.wbt_suggestion',
  'notifications.push_conversation_question',
] as const;
const INTERACTIVE_FAIRNESS_WINDOW = 25;

export type CarbEntryKind = 'MEAL' | 'CORRECTION_CARBS' | 'HYPO_TREATMENT' | 'IGNORED' | 'FAT_PROTEIN_UNITS';

export interface CarbEntryRow {
  event_id: string;
  occurred_at: Date | string;
  payload: Record<string, unknown>;
  event_ingestion_origin: string;
  kind: CarbEntryKind;
  meal_record_id: string | null;
  is_meal_anchor: boolean | null;
}

/** Jobs that answer a caregiver message in a conversation (their correlation id is the conversation). */
const CONVERSATION_RESPONSE_JOB_TYPES = ['conversation.time_range_analysis', 'conversation.direct_response'] as const;

/**
 * A device row of a caregiver still caring for the patient; rows without a user get nothing (sharing audit #22).
 * caregiverDeviceSql narrows it to a push kind.
 */
export const CURRENT_CAREGIVER_DEVICE_SQL = caregiverDeviceSql('any');

/**
 * A reading the caregiver marked as a sensor error (evidence_exclusions, ACTIVE, on the event or on its source record)
 * is not evidence: analyses never read it, as meal records never use one (meal-record-trust). `e` is the events row.
 */
const NOT_EXCLUDED_EVIDENCE_SQL = `NOT EXISTS (
  SELECT 1 FROM evidence_exclusions x
  WHERE x.patient_id = e.patient_id
    AND x.lifecycle_status = 'ACTIVE'
    AND ((x.target_kind = 'EVENT' AND x.target_id = e.id) OR (x.target_kind = 'SOURCE_RECORD' AND x.target_id = e.source_record_id))
)`;

@Injectable()
export class PostgresGlucoMindRepository implements OnApplicationShutdown {
  private readonly logger = new Logger(PostgresGlucoMindRepository.name);

  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  // Last shutdown phase, not onModuleDestroy: Nest destroys the global DatabaseModule before the modules that use it,
  // so ending the pool there cut off the worker's in-flight job and its lease release.
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }

  async getAccessRow(userId: string, patientId: string): Promise<AccessRow | null> {
    const result = await this.pool.query<AccessRow>(
      `
        SELECT
          r.user_id,
          r.patient_id,
          ${memberAllowsSql('r', 'glucose')} AS can_read_patient,
          ${memberAllowsSql('r', 'care')} AS can_write_patient
        FROM caregiver_relationships r
        WHERE r.user_id = $1
          AND r.patient_id = $2
        ORDER BY r.is_owner DESC, ${memberAllowsSql('r', 'care')} DESC
        LIMIT 1
      `,
      [userId, patientId],
    );
    return result.rows[0] ?? null;
  }

  /** The member's scopes for the permission guard; null when not a member (or the id is not a UUID). */
  async getMemberScopes(userId: string, patientId: string): Promise<{ is_owner: boolean; glucose_alerts: boolean; ai_chat_meals: boolean } | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(patientId)) return null;
    const result = await this.pool.query<{ is_owner: boolean; glucose_alerts: boolean; ai_chat_meals: boolean }>(
      `SELECT bool_or(r.is_owner) AS is_owner,
              bool_or(${memberAllowsSql('r', 'glucose_alerts')}) AS glucose_alerts,
              bool_or(${memberAllowsSql('r', 'care')}) AS ai_chat_meals
       FROM caregiver_relationships r WHERE r.user_id = $1 AND r.patient_id = $2::uuid
       HAVING count(*) > 0`,
      [userId, patientId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * The patient's and the caregiver's remote control switches (045_remote_control_flags.sql); null without a
   * relationship. The caregiver's remote_commands counts only when an owner granted it and the caregiver confirmed it
   * (090_sharing_foundation.sql); otherwise it is reported as false.
   */
  async getRemoteControlSwitches(userId: string, patientId: string): Promise<RemoteControlSwitches | null> {
    const result = await this.pool.query<RemoteControlSwitches>(
      `
        SELECT p.remote_control AS patient_remote_control,
               r.permissions || jsonb_build_object('remote_commands', ${EFFECTIVE_REMOTE_COMMANDS_SQL}) AS caregiver_permissions
        FROM caregiver_relationships r
        JOIN patients p ON p.id = r.patient_id
        WHERE r.user_id = $1
          AND r.patient_id = $2
        ORDER BY ${EFFECTIVE_REMOTE_COMMANDS_SQL} DESC
        LIMIT 1
      `,
      [userId, patientId],
    );
    return result.rows[0] ?? null;
  }

  /** The newest imported Nightscout profile document as uploaded (Trio's remote-control fields live there). */
  async getLatestRawNightscoutProfile(patientId: string, atIso: string): Promise<{ raw_profile: unknown; stored_at: string } | null> {
    const row = (await this.pool.query<{ raw_profile: unknown; created_at: Date }>(
      `
        SELECT snapshot->'raw_profile' AS raw_profile, created_at
        FROM therapies
        WHERE patient_id = $1::uuid
          AND (valid_from IS NULL OR valid_from <= $2::timestamptz)
          AND (valid_to IS NULL OR valid_to > $2::timestamptz)
        ORDER BY valid_from DESC NULLS LAST, created_at DESC
        LIMIT 1
      `,
      [patientId, atIso],
    )).rows[0];
    return row ? { raw_profile: row.raw_profile, stored_at: new Date(row.created_at).toISOString() } : null;
  }

  async listAccessiblePatients(userId: string): Promise<Array<{ patient_id: string; display_name: string; birth_year: number | null }>> {
    const result = await this.pool.query<{ patient_id: string; display_name: string; birth_year: number | null }>(
      `
        SELECT DISTINCT p.id AS patient_id, p.display_name, p.birth_year
        FROM caregiver_relationships r
        JOIN patients p ON p.id = r.patient_id
        WHERE r.user_id = $1
        ORDER BY p.display_name ASC, p.id ASC
      `,
      [userId],
    );

    return result.rows;
  }

  /** The patient's year of birth ("Rok urodzenia" in the app); null until a caregiver has set it. */
  async getPatientBirthYear(patientId: string): Promise<number | null> {
    const result = await this.pool.query<{ birth_year: number | null }>(`SELECT birth_year FROM patients WHERE id = $1`, [patientId]);
    return result.rows[0]?.birth_year ?? null;
  }

  /** Sets the patient's year of birth; false when the patient does not exist. */
  async setPatientBirthYear(patientId: string, birthYear: number): Promise<boolean> {
    const result = await this.pool.query(`UPDATE patients SET birth_year = $2, updated_at = now() WHERE id = $1`, [patientId, birthYear]);
    return (result.rowCount ?? 0) > 0;
  }

  /** "Moje instrukcje dla AI": who the user is and their own wishes for the AI; both null until set. */
  async getUserAiPreferences(userId: string): Promise<UserAiPreferences> {
    const result = await this.pool.query<{ ai_role: string | null; ai_instructions: string | null }>(
      `SELECT ai_role, ai_instructions FROM users WHERE id = $1`,
      [userId],
    );
    return normalizeUserAiPreferences(result.rows[0]);
  }

  /** Replaces the user's AI preferences (null clears one); false when the user does not exist. */
  async setUserAiPreferences(userId: string, preferences: UserAiPreferences): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE users SET ai_role = $2, ai_instructions = $3, updated_at = now() WHERE id = $1`,
      [userId, preferences.ai_role, preferences.ai_instructions],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** The caregiver's own name, for the app's greeting; null when the account has none (only its Cognito subject). */
  async getUserDisplayName(userId: string): Promise<string | null> {
    const result = await this.pool.query<{ display_name: string | null }>(
      `
        SELECT
          CASE
            WHEN display_name ~* '^(cognito:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN NULL
            ELSE NULLIF(btrim(display_name), '')
          END AS display_name
        FROM users
        WHERE id = $1
      `,
      [userId],
    );

    return result.rows[0]?.display_name ?? null;
  }

  async patientHasAnyCaregiverRelationship(patientId: string): Promise<boolean> {
    const result = await this.pool.query<{ exists: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM caregiver_relationships
          WHERE patient_id = $1
          LIMIT 1
        ) AS exists
      `,
      [patientId],
    );

    return Boolean(result.rows[0]?.exists);
  }

  /**
   * The user of a Cognito identity, created on first sight. Every authenticated request calls this, so a known identity
   * seen within AUTH_IDENTITY_TOUCH_INTERVAL_MINUTES with unchanged claims costs one SELECT and no write; otherwise
   * last_seen_at and the claims are updated. `touched` tells the caller whether anything was written.
   */
  async resolveOrCreateUserByCognitoSubject(args: ResolveOrCreateUserByCognitoSubjectArgs): Promise<{ userId: string; touched: boolean }> {
    const known = await this.pool.query<{ user_id: string; fresh: boolean; provider_username: string | null; email: string | null; full_name: string | null }>(
      `
        SELECT user_id,
               (last_seen_at IS NOT NULL AND last_seen_at > now() - make_interval(mins => $2::int)) AS fresh,
               provider_username,
               email,
               full_name
        FROM auth_identities
        WHERE provider = 'COGNITO'
          AND provider_subject = $1
        LIMIT 1
      `,
      [args.providerSubject, AUTH_IDENTITY_TOUCH_INTERVAL_MINUTES],
    );
    const row = known.rows[0];
    const unchanged = (claim: string | null, stored: string | null) => claim === null || claim === stored;
    if (row?.fresh && unchanged(args.username, row.provider_username) && unchanged(args.email, row.email) && unchanged(args.fullName, row.full_name)) {
      return { userId: row.user_id, touched: false };
    }

    const resolved = await this.withTransaction(async (client): Promise<{ userId: string }> => {
      const existing = await client.query<{ user_id: string }>(
        `
          SELECT user_id
          FROM auth_identities
          WHERE provider = 'COGNITO'
            AND provider_subject = $1
          LIMIT 1
        `,
        [args.providerSubject],
      );

      if (existing.rows[0]) {
        await client.query(
          `
            UPDATE auth_identities
            SET provider_username = COALESCE($2, provider_username),
                email = COALESCE($3, email),
                full_name = COALESCE($4, full_name),
                last_seen_at = now(),
                updated_at = now()
            WHERE provider = 'COGNITO'
              AND provider_subject = $1
          `,
          [args.providerSubject, args.username, args.email, args.fullName],
        );

        return {
          userId: existing.rows[0].user_id,
        };
      }

      const displayName = args.fullName ?? args.email ?? args.username ?? `cognito:${args.providerSubject}`;
      const createdUser = await client.query<{ id: string }>(
        `
          INSERT INTO users (display_name)
          VALUES ($1)
          RETURNING id
        `,
        [displayName],
      );

      const createdUserId = createdUser.rows[0]?.id;
      if (!createdUserId) {
        throw new Error('FAILED_TO_CREATE_USER');
      }

      try {
        await client.query(
          `
            INSERT INTO auth_identities (
              user_id,
              provider,
              provider_subject,
              provider_username,
              email,
              full_name,
              last_seen_at
            ) VALUES ($1, 'COGNITO', $2, $3, $4, $5, now())
          `,
          [createdUserId, args.providerSubject, args.username, args.email, args.fullName],
        );
      } catch (error) {
        const uniqueConstraintError = error as { code?: string };
        if (uniqueConstraintError.code !== '23505') {
          throw error;
        }

        const concurrentExisting = await client.query<{ user_id: string }>(
          `
            SELECT user_id
            FROM auth_identities
            WHERE provider = 'COGNITO'
              AND provider_subject = $1
            LIMIT 1
          `,
          [args.providerSubject],
        );

        if (!concurrentExisting.rows[0]) {
          throw error;
        }

        return {
          userId: concurrentExisting.rows[0].user_id,
        };
      }

      return {
        userId: createdUserId,
      };
    });
    return { userId: resolved.userId, touched: true };
  }

  async insertAuditEvent(args: AuthAuditEventInput): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO audit_events (
          event_type,
          outcome,
          provider,
          provider_subject,
          user_id,
          request_path,
          metadata
        ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
      `,
      [
        args.eventType,
        args.outcome,
        args.provider,
        args.providerSubject,
        args.userId,
        args.requestPath,
        JSON.stringify(args.metadata),
      ],
    );
  }

  /**
   * Retention of audit_events: deletes at most `limit` rows created before the cutoff (oldest first, by the created_at
   * index) and returns how many. Called in small batches so a large backlog never holds a long lock.
   */
  async deleteAuditEventsOlderThan(cutoffIso: string, limit: number): Promise<number> {
    const result = await this.pool.query(
      `
        DELETE FROM audit_events
        WHERE id IN (
          SELECT id
          FROM audit_events
          WHERE created_at < $1::timestamptz
          ORDER BY created_at
          LIMIT $2
        )
      `,
      [cutoffIso, limit],
    );
    return result.rowCount ?? 0;
  }

  async upsertPatientDevice(args: {
    patientId: string;
    platform: 'ios';
    deviceId: string;
    pushToken: string;
    appVersion: string | null;
    /** The caregiver registering the phone: its pushes stop when their relationship to the patient goes. */
    userId?: string | null;
    /** sha256 of the phone's release secret (migration 085): lets it release its rows later without a session. */
    releaseSecretHash?: string | null;
  }): Promise<PatientDeviceRow> {
    const userId = args.userId ?? null;
    return this.withTransaction(async (client) => {
      const upserted = await client.query<PatientDeviceRow & { inserted: boolean }>(
        `
          INSERT INTO patient_devices (
            patient_id, platform, device_id, push_token, app_version, active, last_seen_at, user_id, release_secret_hash
          ) VALUES ($1,$2,$3,$4,$5,true,now(),$6::uuid,$7)
          ON CONFLICT (patient_id, platform, device_id)
          DO UPDATE SET
            push_token = EXCLUDED.push_token,
            app_version = EXCLUDED.app_version,
            user_id = COALESCE(EXCLUDED.user_id, patient_devices.user_id),
            release_secret_hash = COALESCE(EXCLUDED.release_secret_hash, patient_devices.release_secret_hash),
            active = true,
            last_seen_at = now(),
            updated_at = now()
          RETURNING *, (xmax = 0) AS inserted
        `,
        [args.patientId, args.platform, args.deviceId, args.pushToken, args.appVersion, userId, args.releaseSecretHash ?? null],
      );
      const { inserted, ...row } = upserted.rows[0]!;
      let device: PatientDeviceRow = row;

      // A reinstall gets a new device id but often keeps the APNs token: the new row takes over the old row's
      // switches, so the caregiver's choices survive and the old row cannot keep sending what was switched off
      // (2026-10-26, the rescue switch did nothing after a reinstall). Only for a new row: an existing one has its own.
      if (inserted) {
        const carried = await client.query<PatientDeviceRow>(
          `
            UPDATE patient_devices d
            SET rescue_carb_alerts_enabled = prev.rescue_carb_alerts_enabled,
                answer_ready_push_enabled = prev.answer_ready_push_enabled,
                reservoir_push_enabled = prev.reservoir_push_enabled,
                updated_at = now()
            FROM (
              SELECT p.rescue_carb_alerts_enabled, p.answer_ready_push_enabled, p.reservoir_push_enabled
              FROM patient_devices p
              WHERE p.patient_id = $1 AND p.platform = $2 AND p.push_token = $3 AND p.id <> $4::uuid AND p.active = true
                AND (p.user_id IS NULL OR $5::uuid IS NULL OR p.user_id = $5::uuid)
              ORDER BY p.updated_at DESC
              LIMIT 1
            ) prev
            WHERE d.id = $4::uuid
            RETURNING d.*
          `,
          [args.patientId, args.platform, args.pushToken, device.id, userId],
        );
        device = carried.rows[0] ?? device;
      }

      // The phone now belongs to this registration: an older row of the same patient with this token (an earlier
      // install), and any row of this token or device id left by another account signed in on this phone before
      // (sign-out failed offline), stops getting pushes. The app registers every patient of the signed-in caregiver,
      // so their own rows without a user (before migration 070) come back active in the same pass.
      await client.query(
        `
          UPDATE patient_devices
          SET active = false,
              updated_at = now()
          WHERE platform = $2
            AND active = true
            AND id <> $5::uuid
            AND (
              (patient_id = $1 AND push_token = $3)
              OR ($4::uuid IS NOT NULL AND (push_token = $3 OR device_id = $6) AND (user_id IS NULL OR user_id <> $4::uuid))
            )
        `,
        [args.patientId, args.platform, args.pushToken, userId, device.id, args.deviceId],
      );

      return device;
    });
  }

  /**
   * The phones that get the patient's pushes of one kind: 'care' (answers, reminders, Trio entries, questions) by
   * default, 'glucose_alerts' for glucose alerts, 'any' for every phone with access.
   */
  async listActivePatientDevices(patientId: string, platform: 'ios', scope: MemberScope = 'care'): Promise<PatientDeviceRow[]> {
    const result = await this.pool.query<PatientDeviceRow>(
      `
        SELECT DISTINCT ON (push_token) *
        FROM patient_devices d
        WHERE patient_id = $1
          AND platform = $2
          AND active = true
          AND ${caregiverDeviceSql(scope)}
        ORDER BY push_token, updated_at DESC
      `,
      [patientId, platform],
    );

    return result.rows;
  }

  /**
   * Sign-out on a phone: its push token stops receiving pushes for every patient this user cares for. Rows of patients
   * the user has no relationship with are left alone (another caregiver's phone with the same token is not touched by
   * this user). Returns how many device rows were deactivated.
   */
  async deactivatePatientDevicesForUser(userId: string, platform: 'ios', pushToken: string): Promise<number> {
    const result = await this.pool.query(
      `
        UPDATE patient_devices d
        SET active = false,
            updated_at = now()
        WHERE d.platform = $2
          AND d.push_token = $3
          AND d.active = true
          AND EXISTS (
            SELECT 1
            FROM caregiver_relationships r
            WHERE r.user_id = $1
              AND r.patient_id = d.patient_id
          )
      `,
      [userId, platform, pushToken],
    );
    return result.rowCount ?? 0;
  }

  /**
   * A phone releases its own rows without a session (a sign-out it could not send): every active row with its token
   * whose release secret matches. Returns how many were deactivated.
   */
  async releasePatientDevices(platform: 'ios', pushToken: string, releaseSecretHash: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE patient_devices SET active = false, updated_at = now()
       WHERE platform = $1 AND push_token = $2 AND release_secret_hash = $3 AND active = true`,
      [platform, pushToken, releaseSecretHash],
    );
    return result.rowCount ?? 0;
  }

  async deactivatePatientDevicesByPushToken(platform: 'ios', pushToken: string): Promise<void> {
    await this.pool.query(
      `
        UPDATE patient_devices
        SET active = false,
            updated_at = now()
        WHERE platform = $1
          AND push_token = $2
      `,
      [platform, pushToken],
    );
  }

  async getPushNotificationByDedupeKey(dedupeKey: string): Promise<PushNotificationRow | null> {
    const result = await this.pool.query<PushNotificationRow>(
      `SELECT * FROM push_notifications WHERE dedupe_key = $1 LIMIT 1`,
      [dedupeKey],
    );

    return result.rows[0] ?? null;
  }

  async incrementPushNotificationAttempts(dedupeKey: string): Promise<void> {
    await this.pool.query(
      `
        UPDATE push_notifications
        SET attempts = attempts + 1,
            status = 'running',
            updated_at = now()
        WHERE dedupe_key = $1
      `,
      [dedupeKey],
    );
  }

  async markPushNotificationSent(args: { dedupeKey: string }): Promise<void> {
    await this.pool.query(
      `
        UPDATE push_notifications
        SET status = 'sent',
            sent_at = now(),
            last_error = NULL,
            updated_at = now()
        WHERE dedupe_key = $1
      `,
      [args.dedupeKey],
    );
  }

  async markPushNotificationFailed(args: { dedupeKey: string; retryable: boolean; error: Record<string, unknown> }): Promise<void> {
    await this.pool.query(
      `
        UPDATE push_notifications
        SET status = $2,
            last_error = $3::jsonb,
            updated_at = now()
        WHERE dedupe_key = $1
      `,
      [args.dedupeKey, args.retryable ? 'queued' : 'failed', JSON.stringify(args.error)],
    );
  }

  /**
   * Claims a question's answer push (migration 083): true for the first caller only, so a job rerun after a lost lease
   * never pushes "ready" (or "failed") twice for the same question.
   */
  async claimAnswerPush(args: { patientId: string; questionMessageId: string; outcome: 'ready' | 'failed' }): Promise<boolean> {
    const result = await this.pool.query(
      `
        INSERT INTO answer_push_sent (question_message_id, outcome, patient_id)
        VALUES ($1, $2, $3::uuid)
        ON CONFLICT (question_message_id, outcome) DO NOTHING
      `,
      [args.questionMessageId, args.outcome, args.patientId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** The state of the newest reading (by its own time: a late or backfilled older reading is written later). */
  async getCurrentState(patientId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query<{ snapshot: Record<string, unknown> }>(
      `
        SELECT snapshot
        FROM current_states
        WHERE patient_id = $1
        ORDER BY as_of DESC, updated_at DESC
        LIMIT 1
      `,
      [patientId],
    );

    return result.rows[0]?.snapshot ?? null;
  }

  /**
   * The newest state whose reading was taken at or before asOfIso. By the reading's own time (as_of), not by when the
   * row was written: a reading imported by the refresh before an answer (fresh-glucose.v1) has updated_at = now(),
   * later than the question, and must still win over the older reading.
   */
  async getCurrentStateAtOrBefore(patientId: string, asOfIso: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query<{ snapshot: Record<string, unknown> }>(
      `
        SELECT snapshot
        FROM current_states
        WHERE patient_id = $1
          AND as_of <= $2::timestamptz
        ORDER BY as_of DESC, updated_at DESC
        LIMIT 1
      `,
      [patientId, asOfIso],
    );

    return result.rows[0]?.snapshot ?? null;
  }

  async getPendingInvestigation(patientId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `
        SELECT
          i.id AS investigation_id,
          i.state,
          i.conversation_id,
          i.event_id,
          q.question_id,
          q.question_text
        FROM investigations i
        LEFT JOIN events e
          ON e.id = i.event_id
         AND e.patient_id = i.patient_id
        JOIN context_questions q
          ON q.patient_id = i.patient_id
         AND q.conversation_id = i.conversation_id
         AND q.question_id = i.active_question_id
        WHERE i.patient_id = $1
          AND i.state = 'QUESTION_PENDING'
          AND (i.event_id IS NULL OR e.event_ingestion_origin = 'LIVE')
          AND q.status = 'OPEN'
        ORDER BY i.updated_at DESC, q.created_at DESC, i.id DESC
        LIMIT 1
      `,
      [patientId],
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      investigation_id: row.investigation_id,
      state: row.state,
      question: row.question_text,
      question_id: row.question_id,
      conversation_id: row.conversation_id,
      event_id: row.event_id,
    };
  }

  async listPendingQuestions(patientId: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query(
      `
        SELECT
          q.id,
          i.id AS investigation_id,
          i.state,
          i.conversation_id,
          i.event_id,
          q.question_id,
          q.question_text,
          q.question_type,
          q.created_at,
          q.status,
          c.origin,
          c.conversation_type,
          c.trigger_type
        FROM investigations i
        JOIN conversations c
          ON c.id = i.conversation_id
         AND c.patient_id = i.patient_id
         AND c.deleted_at IS NULL
        LEFT JOIN events e
          ON e.id = i.event_id
         AND e.patient_id = i.patient_id
        JOIN context_questions q
          ON q.patient_id = i.patient_id
         AND q.conversation_id = i.conversation_id
         AND q.question_id = i.active_question_id
        WHERE i.patient_id = $1
          AND i.state = 'QUESTION_PENDING'
          AND (i.event_id IS NULL OR e.event_ingestion_origin = 'LIVE')
          AND q.status = 'OPEN'
        ORDER BY q.created_at DESC, i.updated_at DESC, i.id DESC
      `,
      [patientId],
    );

    return result.rows.map((row) => ({
      id: row.id,
      investigation_id: row.investigation_id,
      state: row.state,
      question_id: row.question_id,
      question_text: row.question_text,
      question_type: row.question_type,
      conversation_id: row.conversation_id,
      event_id: row.event_id,
      created_at: row.created_at,
      status: row.status,
      origin: row.origin,
      conversation_type: row.conversation_type,
      trigger_type: row.trigger_type ?? null,
    }));
  }

  async listHypoEpisodes(patientId: string, state: string, limit: number, cursor: string | null): Promise<{ items: unknown[]; nextCursor: string | null }> {
    const rows = await this.pool.query(
      `
        SELECT
          e.id,
          e.patient_id,
          e.trigger_id,
          e.start_event_id,
          e.state,
          e.severity,
          e.started_at,
          e.ended_at,
          e.latest_event_id,
          e.rule_version,
          e.created_at,
          e.updated_at,
          t.type AS trigger_type,
          c.id AS conversation_id,
          c.awaiting_user_answer,
          c.analysis_id,
          c.recommendation_id
        FROM hypo_episodes e
        JOIN triggers t ON t.id = e.trigger_id
        LEFT JOIN conversations c ON c.patient_id = e.patient_id AND c.episode_id = e.id
        WHERE e.patient_id = $1
          AND ($2 = 'all' OR e.state = CASE WHEN $2 = 'open' THEN 'OPEN' ELSE 'CLOSED' END)
          AND ($3::timestamptz IS NULL OR e.created_at < $3::timestamptz)
        ORDER BY e.created_at DESC
        LIMIT $4 + 1
      `,
      [patientId, state, cursor, limit],
    );

    const items = rows.rows.slice(0, limit).map((row) => ({
      episode_id: row.id,
      trigger_id: row.trigger_id,
      trigger_type: row.trigger_type,
      episode_state: row.state,
      workflow_status: row.awaiting_user_answer ? 'QUESTION_PENDING' : row.recommendation_id ? 'RECOMMENDATION_READY' : row.analysis_id ? 'ANALYSIS_RUNNING' : row.state === 'OPEN' ? 'TRIGGER_CREATED' : 'COMPLETED',
      severity: row.severity,
      started_at: row.started_at,
      latest_reading_at: row.created_at,
      analysis_id: row.analysis_id ?? null,
      recommendation_id: row.recommendation_id ?? null,
      conversation_id: row.conversation_id ?? null,
      updated_at: row.updated_at,
    }));

    // The next page starts after the last row shown (created_at < cursor), so no row is skipped between pages.
    const lastShown = rows.rows.length > limit ? rows.rows[limit - 1] : null;
    const nextCursor = lastShown ? new Date(lastShown.created_at).toISOString() : null;

    return { items, nextCursor };
  }

  /**
   * Pinned conversations come first, all of them on the first page (most recently pinned on top); the cursor pages
   * through the others only, by updated_at.
   */
  async listConversations(patientId: string, limit: number, cursor: string | null): Promise<{ items: unknown[]; nextCursor: string | null }> {
    const rows = await this.pool.query(
      `
        SELECT
          c.id,
          c.patient_id,
          c.episode_id,
          c.trigger_id,
          c.origin,
          c.trigger_type,
          c.thread_state_version,
          c.awaiting_user_answer,
          c.conversation_type,
          c.analysis_id,
          c.recommendation_id,
          c.created_at,
          c.updated_at,
          c.title,
          c.title_source,
          c.pinned_at,
          um.id AS latest_user_message_id,
          um.metadata AS latest_user_message_metadata,
          EXISTS (
            SELECT 1 FROM messages reply
            WHERE reply.conversation_id = c.id
              AND reply.role = 'ASSISTANT'
              AND reply.metadata->>'user_message_id' = um.id::text
          ) AS latest_user_message_has_reply,
          (
            SELECT j.status FROM jobs j
            WHERE j.correlation_id = c.id
              AND j.job_type = ANY($4::text[])
              AND j.payload->>'user_message_id' = um.id::text
            ORDER BY j.created_at DESC
            LIMIT 1
          ) AS latest_user_message_job_status,
          now() AS activity_checked_at,
          (
            SELECT left(regexp_replace(btrim(first_message.content), '[[:space:]]+', ' ', 'g'), 80)
            FROM messages first_message
            WHERE first_message.conversation_id = c.id
              AND first_message.role = 'USER'
              AND first_message.message_type = 'USER_MESSAGE'
            ORDER BY first_message.created_at ASC
            LIMIT 1
          ) AS title_preview
        FROM conversations c
        LEFT JOIN LATERAL (
          SELECT m.id, m.metadata
          FROM messages m
          WHERE m.conversation_id = c.id
            AND m.role = 'USER'
            AND m.message_type = 'USER_MESSAGE'
          ORDER BY m.created_at DESC
          LIMIT 1
        ) um ON TRUE
        LEFT JOIN investigations i
          ON i.patient_id = c.patient_id
         AND i.conversation_id = c.id
         AND i.state = 'QUESTION_PENDING'
        LEFT JOIN context_questions cq
          ON cq.patient_id = c.patient_id
         AND cq.conversation_id = c.id
         AND cq.status = 'OPEN'
        WHERE c.patient_id = $1
          AND c.deleted_at IS NULL
          AND NOT (c.awaiting_user_answer = TRUE AND c.conversation_type = 'TRIGGER_INITIATED' AND i.id IS NOT NULL AND cq.question_id = i.active_question_id)
          AND (
            ($2::timestamptz IS NULL AND c.pinned_at IS NOT NULL)
            OR (c.pinned_at IS NULL AND ($2::timestamptz IS NULL OR c.updated_at < $2::timestamptz))
          )
        ORDER BY c.pinned_at DESC NULLS LAST, c.updated_at DESC, c.id DESC
        LIMIT $3 + 1 + (
          SELECT count(*) FROM conversations pinned
          WHERE $2::timestamptz IS NULL AND pinned.patient_id = $1 AND pinned.pinned_at IS NOT NULL AND pinned.deleted_at IS NULL
        )
      `,
      [patientId, cursor, limit, [...CANCELLABLE_ANALYSIS_JOB_TYPES]],
    );

    const pinnedRows = rows.rows.filter((row) => row.pinned_at !== null && row.pinned_at !== undefined);
    const otherRows = rows.rows.filter((row) => row.pinned_at === null || row.pinned_at === undefined);
    const items = [...pinnedRows, ...otherRows.slice(0, limit)].map((row) => ({
      id: row.id,
      patient_id: row.patient_id,
      episode_id: row.episode_id ?? null,
      trigger_id: row.trigger_id ?? null,
      origin: row.origin,
      trigger_type: row.trigger_type ?? null,
      thread_state_version: row.thread_state_version,
      awaiting_user_answer: row.awaiting_user_answer,
      conversation_type: row.conversation_type,
      workflow_status: row.awaiting_user_answer
        ? 'QUESTION_PENDING'
        : row.recommendation_id
          ? 'RECOMMENDATION_READY'
          : row.analysis_id
            ? 'ANALYSIS_RUNNING'
            : row.trigger_type
              ? 'TRIGGER_CREATED'
              : 'ACTIVE',
      analysis_id: row.analysis_id ?? null,
      recommendation_id: row.recommendation_id ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      // Additive: status snapshot taken with the list, so clients need no per-conversation request.
      activity_status: deriveConversationActivityStatus({
        awaiting_user_answer: Boolean(row.awaiting_user_answer),
        latest_user_message: row.latest_user_message_id
          ? {
            exists: true,
            response_state: parseUserMessageResponseState(row.latest_user_message_metadata),
            has_assistant_reply: Boolean(row.latest_user_message_has_reply),
            job_status: typeof row.latest_user_message_job_status === 'string' ? row.latest_user_message_job_status : null,
          }
          : null,
      }),
      activity_checked_at: row.activity_checked_at ?? null,
      // Additive: the first question the user asked (max 80 chars), a short title for the history list.
      title_preview: typeof row.title_preview === 'string' && row.title_preview.length > 0 ? row.title_preview : null,
      // Additive: the conversation's name (AI with the first answer, or set by a caregiver); null until there is one.
      title: typeof row.title === 'string' && row.title.length > 0 ? row.title : null,
      title_source: row.title ? row.title_source ?? null : null,
      // Additive: set when pinned; pinned conversations come first.
      pinned_at: row.pinned_at ?? null,
    }));

    const nextRow = otherRows[limit];
    const lastRow = otherRows[limit - 1];
    // The last listed row's updated_at (ISO), so the next page starts right after it.
    const nextCursor = nextRow && lastRow
      ? (lastRow.updated_at instanceof Date ? lastRow.updated_at.toISOString() : String(lastRow.updated_at))
      : null;

    return { items, nextCursor };
  }

  async createConversation(args: {
    patientId: string;
    origin: 'USER' | 'SYSTEM';
    conversationType: string;
    threadStateVersion: string;
    awaitingUserAnswer: boolean;
    triggerType?: string | null;
    triggerId?: string | null;
    episodeId?: string | null;
    clientRequestId?: string | null;
  }): Promise<{ conversation: Record<string, unknown>; created: boolean }> {
    const result = await this.pool.query(
      `
        INSERT INTO conversations (
          patient_id,
          episode_id,
          trigger_id,
          origin,
          trigger_type,
          thread_state_version,
          awaiting_user_answer,
          conversation_type,
          client_request_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (patient_id, client_request_id)
        DO NOTHING
        RETURNING *
      `,
      [
        args.patientId,
        args.episodeId ?? null,
        args.triggerId ?? null,
        args.origin,
        args.triggerType ?? null,
        args.threadStateVersion,
        args.awaitingUserAnswer,
        args.conversationType,
        args.clientRequestId ?? null,
      ],
    );

    if (result.rows[0]) {
      return {
        conversation: result.rows[0],
        created: true,
      };
    }

    const existing = await this.pool.query(
      `
        SELECT *
        FROM conversations
        WHERE patient_id = $1
          AND client_request_id = $2
        ORDER BY created_at ASC
        LIMIT 1
      `,
      [args.patientId, args.clientRequestId ?? null],
    );

    return {
      conversation: existing.rows[0],
      created: false,
    };
  }

  async linkConversation(args: { conversationId: string; analysisId: string; recommendationId: string | null }): Promise<void> {
    await this.pool.query(
      `
        UPDATE conversations
        SET analysis_id = $2,
            recommendation_id = $3,
            updated_at = now(),
            thread_state_version = thread_state_version
        WHERE id = $1
      `,
      [args.conversationId, args.analysisId, args.recommendationId],
    );
  }

  async insertAnalysis(args: {
    patientId: string;
    episodeId: string | null;
    triggerId: string | null;
    taskType: string;
    status: string;
    facts: unknown[];
    unknowns: unknown[];
    calculations: unknown[];
    hypotheses: unknown[];
    assumptions: unknown[];
    uncertainty: Record<string, unknown>;
    question: Record<string, unknown> | null;
    proposal: Record<string, unknown> | null;
    rationale: string;
    analysisVersion: string;
    contextPackageId: string | null;
    contextPackageVersion: string | null;
    contextPackageHash: string | null;
    inputHash: string | null;
    promptVersion: string | null;
    modelFingerprint: string | null;
  }): Promise<Record<string, unknown>> {
    const result = await this.pool.query(
      `
        INSERT INTO analyses (
          patient_id, episode_id, trigger_id, task_type, status, facts, unknowns, calculations, hypotheses, assumptions, uncertainty, question, proposal, rationale,
          analysis_version, context_package_id, context_package_version, context_package_hash, input_hash, prompt_version, model_fingerprint
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
        ON CONFLICT (patient_id, episode_id, task_type, context_package_hash)
        DO UPDATE SET
          question = EXCLUDED.question,
          proposal = EXCLUDED.proposal,
          updated_at = now()
        RETURNING *
      `,
      [
        args.patientId,
        args.episodeId,
        args.triggerId,
        args.taskType,
        args.status,
        JSON.stringify(args.facts),
        JSON.stringify(args.unknowns),
        JSON.stringify(args.calculations),
        JSON.stringify(args.hypotheses),
        JSON.stringify(args.assumptions),
        JSON.stringify(args.uncertainty),
        JSON.stringify(args.question),
        JSON.stringify(args.proposal),
        args.rationale,
        args.analysisVersion,
        args.contextPackageId,
        args.contextPackageVersion,
        args.contextPackageHash,
        args.inputHash,
        args.promptVersion,
        args.modelFingerprint,
      ],
    );

    return result.rows[0];
  }

  async insertRecommendation(args: {
    patientId: string;
    analysisId: string;
    episodeId: string | null;
    status: string;
    facts: unknown[];
    unknowns: unknown[];
    calculations: unknown[];
    hypotheses: unknown[];
    proposal: Record<string, unknown>;
    evidence: unknown[];
    provenance: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const result = await this.pool.query(
      `
        INSERT INTO recommendations (
          patient_id, analysis_id, episode_id, status, facts, unknowns, calculations, hypotheses, proposal, evidence, provenance
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (analysis_id)
        DO UPDATE SET updated_at = now()
        RETURNING *
      `,
      [
        args.patientId,
        args.analysisId,
        args.episodeId,
        args.status,
        JSON.stringify(args.facts),
        JSON.stringify(args.unknowns),
        JSON.stringify(args.calculations),
        JSON.stringify(args.hypotheses),
        JSON.stringify(args.proposal),
        JSON.stringify(args.evidence),
        JSON.stringify(args.provenance),
      ],
    );

    return result.rows[0];
  }

  async getAnalysis(patientId: string, analysisId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(`SELECT * FROM analyses WHERE patient_id = $1 AND id = $2 LIMIT 1`, [patientId, analysisId]);
    return result.rows[0] ?? null;
  }

  async getRecommendation(patientId: string, recommendationId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(`SELECT * FROM recommendations WHERE patient_id = $1 AND id = $2 LIMIT 1`, [patientId, recommendationId]);
    return result.rows[0] ?? null;
  }

  /** Nightscout carb entries in [from, to) with their caregiver-set kind and the meal record they belong to. */
  async listCarbEntriesBetween(patientId: string, fromIso: string, toIso: string): Promise<CarbEntryRow[]> {
    const result = await this.pool.query<CarbEntryRow>(
      `
        SELECT
          e.id::text AS event_id,
          e.occurred_at,
          e.payload,
          e.event_ingestion_origin,
          COALESCE(k.kind, 'MEAL') AS kind,
          mre.meal_record_id::text AS meal_record_id,
          (mr.anchor_event_id = e.id) AS is_meal_anchor
        FROM events e
        LEFT JOIN carb_entry_kinds k ON k.patient_id = e.patient_id AND k.event_id = e.id
        LEFT JOIN meal_record_entries mre ON mre.patient_id = e.patient_id AND mre.event_id = e.id
        LEFT JOIN meal_records mr ON mr.id = mre.meal_record_id AND mr.patient_id = e.patient_id
        WHERE e.patient_id = $1
          AND e.type = 'CARB_ENTRY'
          AND e.occurred_at >= $2::timestamptz
          AND e.occurred_at < $3::timestamptz
        ORDER BY e.occurred_at ASC, e.id ASC
      `,
      [patientId, fromIso, toIso],
    );
    return result.rows;
  }

  /** Caregiver-set kinds of the given carb entries (entries without a row are ordinary meals). */
  async listCarbEntryKinds(patientId: string, eventIds: string[]): Promise<Map<string, CarbEntryKind>> {
    if (eventIds.length === 0) return new Map();
    const result = await this.pool.query<{ event_id: string; kind: CarbEntryKind }>(
      `SELECT event_id::text, kind FROM carb_entry_kinds WHERE patient_id = $1 AND event_id = ANY($2::uuid[])`,
      [patientId, eventIds],
    );
    return new Map(result.rows.map((row) => [row.event_id, row.kind]));
  }

  /** Sets what a carb entry really was. False when the event is not a carb entry of this patient. */
  async setCarbEntryKind(patientId: string, eventId: string, kind: CarbEntryKind, userId: string): Promise<boolean> {
    const result = await this.pool.query(
      `
        INSERT INTO carb_entry_kinds (patient_id, event_id, kind, set_by_user_id, set_at)
        SELECT e.patient_id, e.id, $3, $4::uuid, now()
        FROM events e
        WHERE e.patient_id = $1 AND e.id = $2 AND e.type = 'CARB_ENTRY'
        ON CONFLICT (patient_id, event_id)
        DO UPDATE SET kind = EXCLUDED.kind, set_by_user_id = EXCLUDED.set_by_user_id, set_at = now()
        RETURNING event_id
      `,
      [patientId, eventId, kind, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Hides a conversation for every caregiver (soft delete). Idempotent; false when it does not exist. */
  async softDeleteConversation(patientId: string, conversationId: string, userId: string): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE conversations
        SET deleted_at = COALESCE(deleted_at, now()),
            deleted_by_user_id = COALESCE(deleted_by_user_id, $3::uuid)
        WHERE patient_id = $1
          AND id = $2
        RETURNING id
      `,
      [patientId, conversationId, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * A caregiver's changes from the history list: a new name (never replaced by the AI afterwards) and/or the pin.
   * updated_at stays, so the conversation keeps its place among the unpinned ones. False when it does not exist or
   * was deleted.
   */
  async updateConversationListSettings(args: {
    patientId: string;
    conversationId: string;
    userId: string;
    title?: string;
    pinned?: boolean;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE conversations
        SET title = CASE WHEN $4::text IS NULL THEN title ELSE $4::text END,
            title_source = CASE WHEN $4::text IS NULL THEN title_source ELSE 'USER' END,
            title_updated_at = CASE WHEN $4::text IS NULL THEN title_updated_at ELSE now() END,
            pinned_at = CASE
              WHEN $5::boolean IS NULL THEN pinned_at
              WHEN $5::boolean THEN COALESCE(pinned_at, now())
              ELSE NULL
            END,
            pinned_by_user_id = CASE
              WHEN $5::boolean IS NULL THEN pinned_by_user_id
              WHEN $5::boolean THEN COALESCE(pinned_by_user_id, $3::uuid)
              ELSE NULL
            END
        WHERE patient_id = $1
          AND id = $2
          AND deleted_at IS NULL
        RETURNING id
      `,
      [args.patientId, args.conversationId, args.userId, args.title ?? null, args.pinned ?? null],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** The AI's name from the first answer; only when the conversation has no name yet (a caregiver's name wins). */
  async setAiConversationTitleIfMissing(conversationId: string, title: string): Promise<void> {
    await this.pool.query(
      `
        UPDATE conversations
        SET title = $2, title_source = 'AI', title_updated_at = now()
        WHERE id = $1
          AND title IS NULL
      `,
      [conversationId, title],
    );
  }

  /** Whether the conversation is the patient's (deleted ones included); one indexed lookup, no messages. */
  async conversationBelongsToPatient(patientId: string, conversationId: string): Promise<boolean> {
    const result = await this.pool.query(`SELECT 1 FROM conversations WHERE patient_id = $1 AND id = $2 LIMIT 1`, [patientId, conversationId]);
    return (result.rowCount ?? 0) > 0;
  }

  async getConversation(patientId: string, conversationId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(`SELECT * FROM conversations WHERE patient_id = $1 AND id = $2 LIMIT 1`, [patientId, conversationId]);
    if (!result.rows[0]) {
      return null;
    }

    const messages = await this.pool.query(
      `
        SELECT
          m.*,
          ae.estimated_cost AS ai_estimated_cost,
          ae.cost_currency AS ai_cost_currency,
          ae.pricing_version AS ai_pricing_version,
          ae.provider AS ai_provider,
          ae.model AS ai_model,
          -- Cognito users created without a name claim get their subject as display_name; never show that as a name.
          CASE
            WHEN author.display_name ~* '^(cognito:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN NULL
            ELSE author.display_name
          END AS author_display_name
        FROM messages m
        LEFT JOIN users author ON author.id = m.author_user_id
        LEFT JOIN ai_executions ae
          ON ae.id = CASE
            WHEN COALESCE(m.metadata->>'ai_execution_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
              THEN (m.metadata->>'ai_execution_id')::uuid
            ELSE NULL
          END
          AND ae.patient_id = m.patient_id::text
        WHERE m.patient_id = $1
          AND m.conversation_id = $2
        ORDER BY m.created_at ASC
      `,
      [patientId, conversationId],
    );
    const pendingQuestion = await this.pool.query(
      `SELECT * FROM context_questions WHERE patient_id = $1 AND conversation_id = $2 AND status = 'OPEN' ORDER BY created_at DESC LIMIT 1`,
      [patientId, conversationId],
    );
    const processingExecution = await this.pool.query(
      `
        SELECT status, processing_state, updated_at
        FROM (
          -- Only the latest execution counts: an older failure must not outlive a later successful answer.
          SELECT status, processing_state, updated_at
          FROM ai_executions
          WHERE patient_id = $1
            AND correlation_id = $2
          ORDER BY started_at DESC NULLS LAST, updated_at DESC
          LIMIT 1
        ) latest
        WHERE status IN ('running', 'failed')
      `,
      [patientId, conversationId],
    );
    // A failed answer whose job went back to the queue after it (Ponów próbę, or a new question) is being answered
    // again: report it as in progress until the new run writes its own state. If that job fails too, its own failure
    // (or, when it fails before any AI call, this one) is reported again.
    const retriedAfterFailure = String(processingExecution.rows[0]?.status ?? '').toLowerCase() === 'failed'
      ? (await this.pool.query(
        `
          SELECT 1
          FROM jobs
          WHERE patient_id = $1
            AND correlation_id = $2
            AND job_type IN (${CONVERSATION_RESPONSE_JOB_TYPES.map((type) => `'${type}'`).join(', ')})
            AND status IN ('queued', 'running')
            AND updated_at > $3::timestamptz
          LIMIT 1
        `,
        [patientId, conversationId, processingExecution.rows[0].updated_at],
      )).rows.length > 0
      : false;

    const serializedMessages = messages.rows.map((row) => {
      const aiCost = buildAssistantMessageAiCost(row);
      // Tappable next questions stored by the worker on AI answers (always a sanitized string array).
      const suggestions = (row.metadata as Record<string, unknown> | null)?.suggested_follow_ups;
      const suggestionTexts = Array.isArray(suggestions) ? suggestions.filter((entry): entry is string => typeof entry === 'string') : [];
      // The one the model marked as most worth tapping (shown highlighted), only while it is one of the suggestions.
      const hotSuggestion = (row.metadata as Record<string, unknown> | null)?.hot_suggested_follow_up;
      const withSuggestions = suggestionTexts.length > 0
        ? {
          suggested_follow_ups: suggestionTexts,
          ...(typeof hotSuggestion === 'string' && suggestionTexts.includes(hotSuggestion) ? { hot_suggested_follow_up: hotSuggestion } : {}),
        }
        : {};
      // Knowledge-base sources the AI answer cites ([S#] in its text), stored sanitized by the worker.
      const sources = sanitizeKnowledgeSources((row.metadata as Record<string, unknown> | null)?.knowledge_sources);
      const withSources = sources.length > 0 ? { knowledge_sources: sources } : {};
      // Photos attached to a caregiver message (uploaded to conversation_photos, served by id).
      const withPhotos = { photo_ids: messagePhotoIds(row.metadata) };
      // The answer's options (answer-options.v1), stored sanitized by the worker; the app shows them as a picker.
      const options = sanitizeAnswerOptions((row.metadata as Record<string, unknown> | null)?.answer_options);
      const withOptions = options.length > 0 ? { answer_options: options } : {};
      if (!aiCost) {
        return { ...row, ...withSuggestions, ...withSources, ...withPhotos, ...withOptions };
      }

      return {
        ...row,
        ...withSuggestions,
        ...withSources,
        ...withPhotos,
        ...withOptions,
        ai_cost: aiCost,
      };
    });

    return {
      ...result.rows[0],
      messages: serializedMessages,
      pending_question: pendingQuestion.rows[0]
        ? {
            ...pendingQuestion.rows[0],
            expected_answer_types: pendingQuestion.rows[0].expected_answer_types,
            answer_options: getQuestionAnswerOptions(String(pendingQuestion.rows[0].question_id)),
          }
        : null,
      processing: retriedAfterFailure
        ? {
          status: 'PROCESSING',
          current_step: { type: 'QUEUED', status: 'STARTED', label: 'Ponawiam analizę' },
          steps: [],
        }
        : processingExecution.rows[0]?.processing_state
        ? {
          status: String(processingExecution.rows[0].status ?? '').toLowerCase() === 'running' ? 'PROCESSING' : 'FAILED',
          current_step: (processingExecution.rows[0].processing_state as Record<string, unknown>).current_step ?? null,
          steps: Array.isArray((processingExecution.rows[0].processing_state as Record<string, unknown>).steps)
            ? (processingExecution.rows[0].processing_state as Record<string, unknown>).steps
            : [],
        }
        : null,
    };
  }

  async getMessageByIdempotencyKey(conversationId: string, idempotencyKey: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(`SELECT * FROM messages WHERE conversation_id = $1 AND idempotency_key = $2 LIMIT 1`, [conversationId, idempotencyKey]);
    return result.rows[0] ?? null;
  }

  async getMessageById(conversationId: string, messageId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT * FROM messages WHERE conversation_id = $1 AND id = $2 LIMIT 1`,
      [conversationId, messageId],
    );

    return result.rows[0] ?? null;
  }

  async getMessageByQuestionId(conversationId: string, questionId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(
      `SELECT * FROM messages WHERE conversation_id = $1 AND question_id = $2 AND role = 'USER' ORDER BY created_at DESC LIMIT 1`,
      [conversationId, questionId],
    );
    return result.rows[0] ?? null;
  }

  async listEventScopedPatientContextByFactKeys(args: {
    patientId: string;
    eventId: string | null;
    conversationId?: string;
    factKeys: string[];
  }): Promise<Array<Record<string, unknown>>> {
    if (args.factKeys.length === 0) {
      return [];
    }

    const result = args.eventId
      ? await this.pool.query(
        `
          SELECT *
          FROM patient_context
          WHERE patient_id = $1
            AND source_event_id = $2
            AND scope = 'EVENT'
            AND fact_key = ANY($3::text[])
          ORDER BY recorded_at DESC
        `,
        [args.patientId, args.eventId, args.factKeys],
      )
      : await this.pool.query(
        `
          SELECT *
          FROM patient_context
          WHERE patient_id = $1
            AND source_event_id IS NULL
            AND source_conversation_id = $2
            AND scope = 'EVENT'
            AND fact_key = ANY($3::text[])
          ORDER BY recorded_at DESC
        `,
        [args.patientId, args.conversationId ?? null, args.factKeys],
      );

    const latestByKey = new Map<string, Record<string, unknown>>();
    for (const row of result.rows as Array<Record<string, unknown>>) {
      const factKey = String(row.fact_key ?? '');
      if (!latestByKey.has(factKey) && pickLatestUsableEventScopedFact([row])) {
        latestByKey.set(factKey, row);
      }
    }

    return [...latestByKey.values()];
  }

  async listRecentConversationEventFacts(args: {
    patientId: string;
    conversationId: string;
    limit: number;
  }): Promise<Array<Record<string, unknown>>> {
    const boundedLimit = Number.isFinite(args.limit) ? Math.max(1, Math.min(200, Math.floor(args.limit))) : 20;
    const result = await this.pool.query(
      `
        WITH latest AS (
          SELECT DISTINCT ON (fact_key)
            *
          FROM patient_context
          WHERE patient_id = $1
            AND scope = 'EVENT'
            AND source_conversation_id = $2
          ORDER BY fact_key ASC, recorded_at DESC, created_at DESC
        )
        SELECT *
        FROM latest
        ORDER BY recorded_at DESC, created_at DESC
        LIMIT $3
      `,
      [args.patientId, args.conversationId, boundedLimit],
    );

    return result.rows;
  }

  /**
   * Duration of insulin action (hours) of the therapy profile valid at `atIso` (imported Nightscout profile, field
   * `dia`). MISSING when the patient has no such profile or it has no numeric DIA; the value is never defaulted.
   */
  async getTherapyDiaAt(patientId: string, atIso: string): Promise<{ status: 'KNOWN' | 'MISSING'; dia_hours: number | null; therapy_id: string | null; valid_from: string | null }> {
    const row = (await this.pool.query(
      `
        SELECT id::text AS id, valid_from, snapshot->'profile'->>'dia' AS dia
        FROM therapies
        WHERE patient_id = $1::uuid
          AND (valid_from IS NULL OR valid_from <= $2::timestamptz)
          AND (valid_to IS NULL OR valid_to > $2::timestamptz)
        ORDER BY valid_from DESC NULLS LAST, created_at DESC
        LIMIT 1
      `,
      [patientId, atIso],
    )).rows[0];
    const dia = row?.dia !== undefined && row?.dia !== null ? Number(row.dia) : Number.NaN;
    if (!row || !(Number.isFinite(dia) && dia > 0)) {
      return { status: 'MISSING', dia_hours: null, therapy_id: row ? String(row.id) : null, valid_from: row?.valid_from ? new Date(row.valid_from).toISOString() : null };
    }
    return { status: 'KNOWN', dia_hours: dia, therapy_id: String(row.id), valid_from: row.valid_from ? new Date(row.valid_from).toISOString() : null };
  }

  /**
   * Therapy profile valid at `atIso` (imported Nightscout profile), compacted to schedules of [HH:MM, value]. MISSING when
   * the patient has no such profile; schedules absent from the profile stay null (never defaulted).
   */
  /**
   * The pump's bolus step (pump.bolusIncrement) from Trio's newest device status since a time; null when the loop
   * does not report it (Loop, older Trio) or reported nothing recently.
   */
  /**
   * The patient's Nightscout history import state (nightscout-history.v1): the source's metadata and its oldest imported
   * CGM reading. Null without a Nightscout source.
   */
  async getNightscoutHistoryState(patientId: string): Promise<{ metadata: Record<string, unknown>; oldest_reading_at: string | null } | null> {
    const result = await this.pool.query<{ metadata: Record<string, unknown> | null; oldest_reading_at: Date | string | null }>(
      `SELECT s.metadata,
              (SELECT sr.occurred_at FROM source_records sr
                WHERE sr.patient_id = s.patient_id AND sr.record_type = 'CGM_ENTRY'
                ORDER BY sr.occurred_at ASC LIMIT 1) AS oldest_reading_at
       FROM sources s
       WHERE s.patient_id = $1::uuid AND s.source_system = 'NIGHTSCOUT' AND s.enabled
       ORDER BY s.created_at ASC
       LIMIT 1`,
      [patientId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { metadata: row.metadata ?? {}, oldest_reading_at: row.oldest_reading_at ? new Date(row.oldest_reading_at).toISOString() : null };
  }

  /**
   * Loop's insulin on its newest uploaded dose since `sinceIso` (`insulinType`, e.g. "Novolog", "Fiasp"): the source of
   * the Bolus chart's insulin curve (insulin-curve.v1). Null when none (Trio's treatments have no insulinType).
   */
  async getLoopInsulinType(patientId: string, sinceIso: string): Promise<string | null> {
    const result = await this.pool.query<{ insulin_type: string | null }>(
      `SELECT raw_payload->>'insulinType' AS insulin_type
       FROM source_records
       WHERE patient_id = $1::uuid AND record_type = 'TREATMENT' AND occurred_at >= $2::timestamptz
         AND jsonb_typeof(raw_payload->'insulinType') = 'string'
       ORDER BY occurred_at DESC
       LIMIT 1`,
      [patientId, sinceIso],
    );
    const type = result.rows[0]?.insulin_type;
    return typeof type === 'string' && type.trim() ? type.trim() : null;
  }

  async getPumpBolusIncrement(patientId: string, sinceIso: string): Promise<number | null> {
    const result = await this.pool.query<{ step: string | number | null }>(
      `SELECT (raw_payload->'pump'->>'bolusIncrement')::numeric AS step
       FROM source_records
       WHERE patient_id = $1::uuid AND record_type = 'DEVICE_STATUS' AND occurred_at >= $2::timestamptz
         AND jsonb_typeof(raw_payload->'pump'->'bolusIncrement') = 'number'
       ORDER BY occurred_at DESC
       LIMIT 1`,
      [patientId, sinceIso],
    );
    const step = result.rows[0]?.step;
    return step === null || step === undefined ? null : Number(step);
  }

  async getTherapyProfileAt(patientId: string, atIso: string): Promise<{
    status: 'KNOWN' | 'MISSING';
    therapy_id: string | null;
    valid_from: string | null;
    units: string | null;
    timezone: string | null;
    dia_hours: number | null;
    carb_ratio_g_per_u: Array<[string, number]> | null;
    sensitivity_per_u: Array<[string, number]> | null;
    basal_u_per_h: Array<[string, number]> | null;
    target_low: Array<[string, number]> | null;
    target_high: Array<[string, number]> | null;
  }> {
    const row = (await this.pool.query(
      `
        SELECT id::text AS id, valid_from, snapshot->'profile' AS profile
        FROM therapies
        WHERE patient_id = $1::uuid
          AND (valid_from IS NULL OR valid_from <= $2::timestamptz)
          AND (valid_to IS NULL OR valid_to > $2::timestamptz)
        ORDER BY valid_from DESC NULLS LAST, created_at DESC
        LIMIT 1
      `,
      [patientId, atIso],
    )).rows[0];
    const profile = (row?.profile ?? null) as Record<string, unknown> | null;
    const schedule = (value: unknown): Array<[string, number]> | null => {
      if (!Array.isArray(value) || value.length === 0) return null;
      const entries = value
        .map((entry) => entry as Record<string, unknown>)
        .filter((entry) => typeof entry.time === 'string' && Number.isFinite(Number(entry.value)))
        .map((entry) => [String(entry.time), Number(entry.value)] as [string, number]);
      return entries.length > 0 ? entries : null;
    };
    const dia = Number(profile?.dia);
    return {
      status: profile ? 'KNOWN' : 'MISSING',
      therapy_id: row ? String(row.id) : null,
      valid_from: row?.valid_from ? new Date(row.valid_from).toISOString() : null,
      units: typeof profile?.units === 'string' ? profile.units : null,
      timezone: typeof profile?.timezone === 'string' ? profile.timezone : null,
      dia_hours: Number.isFinite(dia) && dia > 0 ? dia : null,
      carb_ratio_g_per_u: schedule(profile?.carbratio),
      sensitivity_per_u: schedule(profile?.sens),
      basal_u_per_h: schedule(profile?.basal),
      target_low: schedule(profile?.target_low),
      target_high: schedule(profile?.target_high),
    };
  }

  async listPatientEventsByRange(args: {
    patientId: string;
    startAtIso: string;
    endAtIso: string;
    limit: number;
    /** Event types left out of the selection (and of its row limit). */
    excludeTypes?: readonly string[];
    /** NEWEST: when the limit cuts the range, the most recent events are kept (still returned oldest first). */
    keep?: 'OLDEST' | 'NEWEST';
  }): Promise<Array<Record<string, unknown>>> {
    const boundedLimit = Number.isFinite(args.limit) ? Math.max(1, Math.min(5000, Math.floor(args.limit))) : 1500;
    const newest = args.keep === 'NEWEST';
    const result = await this.pool.query(
      `
        SELECT
          e.id,
          e.patient_id,
          e.source_record_id,
          e.type,
          e.occurred_at,
          e.recorded_at,
          e.source,
          e.context,
          -- What a carb entry really was (caregiver-set); only present when it is not an ordinary meal.
          CASE
            WHEN k.kind IS NOT NULL AND k.kind <> 'MEAL' THEN e.payload || jsonb_build_object('carb_kind', k.kind)
            ELSE e.payload
          END AS payload,
          e.created_at,
          e.updated_at
        FROM events e
        LEFT JOIN carb_entry_kinds k ON k.patient_id = e.patient_id AND k.event_id = e.id
        WHERE e.patient_id = $1
          AND e.occurred_at >= $2::timestamptz
          AND e.occurred_at <= $3::timestamptz
          AND NOT (e.type = ANY($5::text[]))
          AND ${NOT_EXCLUDED_EVIDENCE_SQL}
        ORDER BY e.occurred_at ${newest ? 'DESC' : 'ASC'}, e.created_at ${newest ? 'DESC' : 'ASC'}, e.id ${newest ? 'DESC' : 'ASC'}
        LIMIT $4
      `,
      [args.patientId, args.startAtIso, args.endAtIso, boundedLimit, [...(args.excludeTypes ?? [])]],
    );

    return newest ? result.rows.reverse() : result.rows;
  }

  /**
   * Bolus, SMB and temp basal events of a range, without the row limit of listPatientEventsByRange (whose glucose
   * readings fill it on long ranges): the input of daily insulin totals. Bounded only as a safety net.
   */
  async listInsulinDeliveryEventsByRange(args: {
    patientId: string;
    startAtIso: string;
    endAtIso: string;
  }): Promise<Array<{ event_id: string; type: string; occurred_at: string; payload: Record<string, unknown> }>> {
    const result = await this.pool.query(
      `
        SELECT e.id::text AS event_id, e.type, e.occurred_at, e.payload
        FROM events e
        WHERE e.patient_id = $1
          AND e.type IN ('BOLUS', 'SMB', 'TEMP_BASAL')
          AND e.occurred_at >= $2::timestamptz
          AND e.occurred_at <= $3::timestamptz
        ORDER BY e.occurred_at ASC, e.created_at ASC, e.id ASC
        LIMIT 40000
      `,
      [args.patientId, args.startAtIso, args.endAtIso],
    );
    return result.rows.map((row) => ({
      event_id: String(row.event_id),
      type: String(row.type),
      occurred_at: new Date(row.occurred_at).toISOString(),
      payload: (row.payload ?? {}) as Record<string, unknown>,
    }));
  }

  /**
   * Glucose aggregates of every reading in a range (count, min, max, mean, readings per consensus band), without the row
   * limit of listPatientEventsByRange: what a long analysis reports when its event selection was cut. Values are read
   * as the analysis reads them (payload glucose_value, glucose, raw_payload.sgv; positive numbers only).
   */
  async getGlucoseAggregatesByRange(args: { patientId: string; startAtIso: string; endAtIso: string }): Promise<{
    count: number;
    min: number | null;
    max: number | null;
    avg: number | null;
    bands: { very_low: number; low: number; in_range: number; high: number; very_high: number };
  }> {
    const result = await this.pool.query(
      `
        WITH readings AS (
          SELECT CASE
            WHEN jsonb_typeof(e.payload->'glucose_value') = 'number' THEN (e.payload->>'glucose_value')::numeric
            WHEN jsonb_typeof(e.payload->'glucose') = 'number' THEN (e.payload->>'glucose')::numeric
            WHEN jsonb_typeof(e.payload->'raw_payload'->'sgv') = 'number' THEN (e.payload->'raw_payload'->>'sgv')::numeric
          END AS value
          FROM events e
          WHERE e.patient_id = $1
            AND e.type IN ('GLUCOSE_READING_AVAILABLE', 'GLUCOSE_READING', 'GLUCOSE')
            AND e.occurred_at >= $2::timestamptz
            AND e.occurred_at <= $3::timestamptz
            AND ${NOT_EXCLUDED_EVIDENCE_SQL}
        )
        SELECT
          COUNT(*)::int AS count,
          MIN(value)::float8 AS min,
          MAX(value)::float8 AS max,
          AVG(value)::float8 AS avg,
          COUNT(*) FILTER (WHERE value < ${TIR_VERY_LOW_BELOW_MGDL})::int AS very_low,
          COUNT(*) FILTER (WHERE value >= ${TIR_VERY_LOW_BELOW_MGDL} AND value < 70)::int AS low,
          COUNT(*) FILTER (WHERE value > 180 AND value <= 250)::int AS high,
          COUNT(*) FILTER (WHERE value > 250)::int AS very_high
        FROM readings
        WHERE value > 0
      `,
      [args.patientId, args.startAtIso, args.endAtIso],
    );
    const row = result.rows[0] ?? {};
    const count = Number(row.count ?? 0);
    const veryLow = Number(row.very_low ?? 0);
    const low = Number(row.low ?? 0);
    const high = Number(row.high ?? 0);
    const veryHigh = Number(row.very_high ?? 0);
    const number = (value: unknown) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value));
    return {
      count,
      min: number(row.min),
      max: number(row.max),
      avg: number(row.avg),
      bands: { very_low: veryLow, low, in_range: count - veryLow - low - high - veryHigh, high, very_high: veryHigh },
    };
  }

  /**
   * Event counts of a range by kind (glucose readings, boluses, SMBs, temp basals, the loop's IOB/COB snapshots), counts
   * only: what the "no data" answer check compares an answer's claims with.
   */
  async countPatientDataInRange(args: { patientId: string; startAtIso: string; endAtIso: string }): Promise<{
    glucose_readings: number;
    boluses: number;
    smbs: number;
    temp_basals: number;
    loop_snapshots: number;
  }> {
    const result = await this.pool.query(
      `
        SELECT
          COUNT(*) FILTER (WHERE e.type IN ('GLUCOSE_READING_AVAILABLE', 'GLUCOSE_READING', 'GLUCOSE'))::int AS glucose_readings,
          COUNT(*) FILTER (WHERE e.type = 'BOLUS')::int AS boluses,
          COUNT(*) FILTER (WHERE e.type = 'SMB')::int AS smbs,
          COUNT(*) FILTER (WHERE e.type = 'TEMP_BASAL')::int AS temp_basals,
          COUNT(*) FILTER (WHERE e.type IN ('IOB_SNAPSHOT', 'COB_SNAPSHOT'))::int AS loop_snapshots
        FROM events e
        WHERE e.patient_id = $1
          AND e.type IN ('GLUCOSE_READING_AVAILABLE', 'GLUCOSE_READING', 'GLUCOSE', 'BOLUS', 'SMB', 'TEMP_BASAL', 'IOB_SNAPSHOT', 'COB_SNAPSHOT')
          AND e.occurred_at >= $2::timestamptz
          AND e.occurred_at <= $3::timestamptz
      `,
      [args.patientId, args.startAtIso, args.endAtIso],
    );
    const row = result.rows[0] ?? {};
    return {
      glucose_readings: Number(row.glucose_readings ?? 0),
      boluses: Number(row.boluses ?? 0),
      smbs: Number(row.smbs ?? 0),
      temp_basals: Number(row.temp_basals ?? 0),
      loop_snapshots: Number(row.loop_snapshots ?? 0),
    };
  }

  /**
   * Hypo episodes intersecting a range, oldest first. `keep: 'NEWEST'`: when the limit cuts them, the most recent are
   * kept; every row carries `total_in_range`, the count before the limit.
   */
  async listHypoEpisodesIntersectingRange(args: {
    patientId: string;
    startAtIso: string;
    endAtIso: string;
    limit: number;
    keep?: 'OLDEST' | 'NEWEST';
  }): Promise<Array<Record<string, unknown>>> {
    const boundedLimit = Number.isFinite(args.limit) ? Math.max(1, Math.min(200, Math.floor(args.limit))) : 50;
    const order = args.keep === 'NEWEST' ? 'DESC' : 'ASC';
    const result = await this.pool.query(
      `
        SELECT
          id,
          patient_id,
          trigger_id,
          start_event_id,
          state,
          severity,
          started_at,
          ended_at,
          latest_event_id,
          rule_version,
          created_at,
          updated_at,
          COUNT(*) OVER ()::int AS total_in_range
        FROM hypo_episodes
        WHERE patient_id = $1
          AND started_at <= $3::timestamptz
          AND COALESCE(ended_at, $3::timestamptz) >= $2::timestamptz
        ORDER BY started_at ${order}, created_at ${order}, id ${order}
        LIMIT $4
      `,
      [args.patientId, args.startAtIso, args.endAtIso, boundedLimit],
    );

    return args.keep === 'NEWEST' ? result.rows.reverse() : result.rows;
  }

  /**
   * EVENT-scope facts recorded in a range, oldest first. `keep: 'NEWEST'`: when the limit cuts them, the most recent are
   * kept; every row carries `total_in_range`, the count before the limit.
   */
  async listPatientContextFactsByRecordedRange(args: {
    patientId: string;
    startAtIso: string;
    endAtIso: string;
    limit: number;
    keep?: 'OLDEST' | 'NEWEST';
  }): Promise<Array<Record<string, unknown>>> {
    const boundedLimit = Number.isFinite(args.limit) ? Math.max(1, Math.min(500, Math.floor(args.limit))) : 100;
    const order = args.keep === 'NEWEST' ? 'DESC' : 'ASC';
    const result = await this.pool.query(
      `
        SELECT *, COUNT(*) OVER ()::int AS total_in_range
        FROM patient_context
        WHERE patient_id = $1
          AND scope = 'EVENT'
          AND recorded_at >= $2::timestamptz
          AND recorded_at <= $3::timestamptz
        ORDER BY recorded_at ${order}, created_at ${order}, id ${order}
        LIMIT $4
      `,
      [args.patientId, args.startAtIso, args.endAtIso, boundedLimit],
    );

    return args.keep === 'NEWEST' ? result.rows.reverse() : result.rows;
  }

  async getInvestigationByConversation(patientId: string, conversationId: string): Promise<InvestigationRow | null> {
    const result = await this.pool.query<InvestigationRow>(
      `SELECT * FROM investigations WHERE patient_id = $1 AND conversation_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [patientId, conversationId],
    );

    return result.rows[0] ?? null;
  }

  async evaluateInvestigationForEvent(args: {
    patientId: string;
    eventId: string | null;
    eventFamily: InvestigationEventFamily;
    conversationId: string;
    episodeId: string | null;
    triggerId: string | null;
    phase: 'INITIAL' | 'RE_EVALUATE';
  }): Promise<{
    investigation: InvestigationRow;
    decision: InvestigationDecision;
    state: InvestigationState;
    activeQuestionId: string | null;
    shouldProceedToAnalysis: boolean;
  }> {
    return this.withTransaction(async (client) => {
      if (args.eventId) {
        await client.query(
          `
            INSERT INTO investigations (
              patient_id, event_id, event_family, state, active_question_id,
              conversation_id, episode_id, trigger_id, last_decision, last_decision_reason
            ) VALUES ($1,$2,$3,'NEW',NULL,$4,$5,$6,'FINISH','Investigation created.')
            ON CONFLICT (event_id)
            DO UPDATE SET
              conversation_id = EXCLUDED.conversation_id,
              episode_id = EXCLUDED.episode_id,
              trigger_id = EXCLUDED.trigger_id,
              updated_at = now()
          `,
          [args.patientId, args.eventId, args.eventFamily, args.conversationId, args.episodeId, args.triggerId],
        );
      } else {
        await client.query(
          `
            INSERT INTO investigations (
              patient_id, event_id, event_family, state, active_question_id,
              conversation_id, episode_id, trigger_id, last_decision, last_decision_reason
            ) VALUES ($1,NULL,$2,'NEW',NULL,$3,NULL,NULL,'FINISH','Investigation created.')
            ON CONFLICT (patient_id, conversation_id)
            WHERE event_family = 'USER' AND event_id IS NULL
            DO UPDATE SET
              event_family = EXCLUDED.event_family,
              updated_at = now()
          `,
          [args.patientId, args.eventFamily, args.conversationId],
        );
      }

      const lockResult = await client.query<InvestigationRow>(
        `
          SELECT *
          FROM investigations
          WHERE patient_id = $1
            AND (event_id = $2 OR (event_id IS NULL AND conversation_id = $3))
          FOR UPDATE
        `,
        [args.patientId, args.eventId, args.conversationId],
      );
      const locked = lockResult.rows[0];
      if (!locked) {
        throw new Error('INVESTIGATION_NOT_FOUND');
      }

      const originResult = args.eventId
        ? await client.query<{ event_ingestion_origin: string }>(
          `
            SELECT event_ingestion_origin
            FROM events
            WHERE id = $1 AND patient_id = $2
            LIMIT 1
          `,
          [args.eventId, args.patientId],
        )
        : { rows: [] as Array<{ event_ingestion_origin: string }> };

      const eventIngestionOrigin = args.eventId ? String(originResult.rows[0]?.event_ingestion_origin ?? 'LIVE') : 'LIVE';
      const userFacingEligible = eventIngestionOrigin === 'LIVE';

      if (locked.state === 'RESOLVED' || locked.state === 'CLOSED') {
        return {
          investigation: locked,
          decision: (locked.last_decision as InvestigationDecision) ?? 'FINISH',
          state: locked.state as InvestigationState,
          activeQuestionId: locked.active_question_id,
          shouldProceedToAnalysis: false,
        };
      }

      if (!userFacingEligible) {
        await client.query(
          `
            UPDATE conversations
            SET awaiting_user_answer = false,
                updated_at = now()
            WHERE id = $1
          `,
          [args.conversationId],
        );

        const historicalInvestigation = await client.query<InvestigationRow>(
          `
            UPDATE investigations
            SET state = 'FINISHED_NO_QUESTION',
                active_question_id = NULL,
                last_decision = 'FINISH',
                last_decision_reason = $2,
                updated_at = now()
            WHERE id = $1
            RETURNING *
          `,
          [locked.id, `Event origin ${eventIngestionOrigin} is analytical-only and not eligible for a user-facing pending investigation.`],
        );

        return {
          investigation: historicalInvestigation.rows[0],
          decision: 'FINISH',
          state: 'FINISHED_NO_QUESTION',
          activeQuestionId: null,
          shouldProceedToAnalysis: true,
        };
      }

      if (args.phase === 'RE_EVALUATE') {
        await client.query(
          `
            UPDATE investigations
            SET state = 'RE_EVALUATING',
                active_question_id = NULL,
                updated_at = now()
            WHERE id = $1
          `,
          [locked.id],
        );
      } else if (locked.state === 'NEW') {
        await client.query(
          `
            UPDATE investigations
            SET state = 'OPEN',
                updated_at = now()
            WHERE id = $1
          `,
          [locked.id],
        );
      }

      const openQuestionResult = await client.query<{ question_id: string }>(
        `
          SELECT question_id
          FROM context_questions
          WHERE patient_id = $1
            AND conversation_id = $2
            AND status = 'OPEN'
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [args.patientId, args.conversationId],
      );
      const openQuestionId = openQuestionResult.rows[0]?.question_id ?? null;

      if (openQuestionId && args.phase === 'INITIAL') {
        const pendingInvestigation = await client.query<InvestigationRow>(
          `
            UPDATE investigations
            SET state = 'QUESTION_PENDING',
                active_question_id = $2,
                last_decision = 'ASK_NOW',
                last_decision_reason = 'Existing open question is still pending.',
                updated_at = now()
            WHERE id = $1
            RETURNING *
          `,
          [locked.id, openQuestionId],
        );

        return {
          investigation: pendingInvestigation.rows[0],
          decision: 'ASK_NOW',
          state: 'QUESTION_PENDING',
          activeQuestionId: openQuestionId,
          shouldProceedToAnalysis: false,
        };
      }

      let conversationContext = null;
      if (args.eventFamily === 'USER') {
        const recentMessagesResult = await client.query<{
          id: string;
          content: string;
          role: string;
          message_type: string;
        }>(
          `
            SELECT id, content, role, message_type
            FROM messages
            WHERE patient_id = $1
              AND conversation_id = $2
            ORDER BY created_at DESC
            LIMIT 10
          `,
          [args.patientId, args.conversationId],
        );

        const recentMessages = recentMessagesResult.rows ?? [];
        const userMessage = [...recentMessages].find((message) => String(message.role ?? '').toUpperCase() === 'USER') ?? recentMessages[0] ?? null;
        const knownEpisodeCandidatesResult = await client.query<{ episode_id: string; started_at: string | null; ended_at: string | null }>(
          `
            SELECT id AS episode_id, started_at, ended_at
            FROM hypo_episodes
            WHERE patient_id = $1
              AND started_at >= now() - interval '7 days'
            ORDER BY started_at DESC
            LIMIT 50
          `,
          [args.patientId],
        );

        conversationContext = userMessage
          ? resolveConversationContext({
              conversation_id: args.conversationId,
              current_user_message_id: userMessage.id ?? null,
              current_user_message: String(userMessage.content ?? ''),
              // Oldest first, as the resolver reads them (the query returns the newest first).
              previous_messages: [...recentMessages]
                .reverse()
                .filter((message) => String(message.id ?? '') !== String(userMessage.id ?? ''))
                .map((message) => ({
                  id: message.id,
                  role: String(message.role ?? '').toUpperCase() === 'USER' ? 'USER' : 'ASSISTANT',
                  message_type: String(message.message_type ?? 'OTHER') as any,
                  content: message.content,
                })),
              known_episode_candidates: (knownEpisodeCandidatesResult.rows ?? []).map((row) => ({
                episode_id: row.episode_id,
                started_at: row.started_at,
                ended_at: row.ended_at,
              })),
            })
          : null;
      }

      const candidates = getCandidateRegistry(args.eventFamily, conversationContext);
      const factKeys = candidates.map((candidate) => candidate.fact_key);
      const factRows = factKeys.length > 0
        ? args.eventId
          ? await client.query(
            `
              SELECT *
              FROM patient_context
              WHERE patient_id = $1
                AND source_event_id = $2
                AND scope = 'EVENT'
                AND fact_key = ANY($3::text[])
              ORDER BY recorded_at DESC
            `,
            [args.patientId, args.eventId, factKeys],
          )
          : await client.query(
            `
              SELECT *
              FROM patient_context
              WHERE patient_id = $1
                AND source_event_id IS NULL
                AND source_conversation_id = $2
                AND scope = 'EVENT'
                AND fact_key = ANY($3::text[])
              ORDER BY recorded_at DESC
            `,
            [args.patientId, args.conversationId, factKeys],
          )
        : { rows: [] as Array<Record<string, unknown>> };

      const latestByKey = new Map<string, Record<string, unknown>>();
      for (const row of factRows.rows as Array<Record<string, unknown>>) {
        const factKey = String(row.fact_key ?? '');
        if (!latestByKey.has(factKey) && pickLatestUsableEventScopedFact([row])) {
          latestByKey.set(factKey, row);
        }
      }

      const evaluation = evaluateInvestigationDecision({
        eventFamily: args.eventFamily,
        eventFacts: [...latestByKey.values()],
        activeQuestionId: null,
        conversationContext,
      });

      if (evaluation.decision === 'ASK_NOW' && evaluation.candidate) {
        const candidate = evaluation.candidate;
        const questionText = await this.buildDeterministicQuestionTextForInvestigation({
          client,
          patientId: args.patientId,
          eventFamily: args.eventFamily,
          episodeId: args.episodeId,
          conversationId: args.conversationId,
          questionId: candidate.candidate_id,
          baseQuestionText: candidate.question_text,
        });

        await client.query(
          `
            INSERT INTO context_questions (
              conversation_id, patient_id, question_id, question_type, question_text,
              reason, expected_information_gain, expected_answer_types, related_event_id, status
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,'OPEN')
            ON CONFLICT (conversation_id, question_id)
            DO UPDATE SET
              question_type = EXCLUDED.question_type,
              question_text = EXCLUDED.question_text,
              reason = EXCLUDED.reason,
              expected_information_gain = EXCLUDED.expected_information_gain,
              expected_answer_types = EXCLUDED.expected_answer_types,
              related_event_id = EXCLUDED.related_event_id,
              status = 'OPEN',
              updated_at = now()
          `,
          [
            args.conversationId,
            args.patientId,
            candidate.candidate_id,
            candidate.question_type,
            questionText,
            candidate.reason,
            candidate.expected_information_gain,
            JSON.stringify(candidate.expected_answer_types),
            args.eventId,
          ],
        );

        await client.query(
          `
            UPDATE conversations
            SET awaiting_user_answer = true,
                updated_at = now()
            WHERE id = $1
          `,
          [args.conversationId],
        );

        await client.query(
          `
            INSERT INTO messages (
              conversation_id, patient_id, role, message_type, content, question_id,
              answer_type, answer_text, answer_value, provenance_ref, metadata, idempotency_key
            ) VALUES ($1,$2,'SYSTEM','CONTEXT_QUESTION',$3,$4,NULL,NULL,NULL,$5,$6::jsonb,$7)
            ON CONFLICT (conversation_id, idempotency_key)
            DO UPDATE SET updated_at = now()
          `,
          [
            args.conversationId,
            args.patientId,
            questionText,
            candidate.candidate_id,
            `trigger/${args.triggerId}/question/${candidate.candidate_id}`,
            JSON.stringify({
              question_id: candidate.candidate_id,
              question_type: candidate.question_type,
              expected_answer_types: candidate.expected_answer_types,
              candidate_version: candidate.version,
              created_at: new Date().toISOString(),
            }),
            `context-question:${args.conversationId}:${args.eventId}:${candidate.candidate_id}`,
          ],
        );

        const pushDedupeKey = `conversation-question:${args.patientId}:${args.conversationId}:${candidate.candidate_id}`;
        await client.query(
          `
            INSERT INTO push_notifications (
              dedupe_key, patient_id, conversation_id, question_id, notification_type, payload, status
            ) VALUES ($1,$2,$3,$4,'conversation_question',$5::jsonb,'queued')
            ON CONFLICT (dedupe_key)
            DO UPDATE SET updated_at = now()
          `,
          [
            pushDedupeKey,
            args.patientId,
            args.conversationId,
            candidate.candidate_id,
            JSON.stringify({
              type: 'conversation_question',
              patientId: args.patientId,
              conversationId: args.conversationId,
              questionId: candidate.candidate_id,
              routePath: `/patients/${args.patientId}/conversations/${args.conversationId}`,
              universalLink: `${APP_LINK_ORIGIN}/patients/${args.patientId}/conversations/${args.conversationId}`,
            }),
          ],
        );

        await client.query(
          `
            INSERT INTO jobs (
              job_type, status, payload_version, payload, dedupe_key, correlation_id, causation_id, patient_id, available_at, max_attempts
            ) VALUES ('notifications.push_conversation_question','queued',1,$1::jsonb,$2,$3,$4,$5,$6::timestamptz,5)
            ON CONFLICT (job_type, dedupe_key)
            DO UPDATE SET updated_at = now()
          `,
          [
            JSON.stringify({
              patient_id: args.patientId,
              conversation_id: args.conversationId,
              question_id: candidate.candidate_id,
              notification_dedupe_key: pushDedupeKey,
            }),
            pushDedupeKey,
            args.conversationId,
            args.triggerId,
            args.patientId,
            new Date(Date.now() + 5_000).toISOString(),
          ],
        );

        const investigation = await client.query<InvestigationRow>(
          `
            UPDATE investigations
            SET state = 'QUESTION_PENDING',
                active_question_id = $2,
                last_decision = 'ASK_NOW',
                last_decision_reason = $3,
                updated_at = now()
            WHERE id = $1
            RETURNING *
          `,
          [locked.id, candidate.candidate_id, evaluation.reason],
        );

        return {
          investigation: investigation.rows[0],
          decision: 'ASK_NOW',
          state: 'QUESTION_PENDING',
          activeQuestionId: candidate.candidate_id,
          shouldProceedToAnalysis: false,
        };
      }

      const finalState: InvestigationState = evaluation.decision === 'ASK_LATER'
        ? 'FINISHED_ASK_LATER'
        : 'FINISHED_NO_QUESTION';

      await client.query(
        `
          UPDATE conversations
          SET awaiting_user_answer = false,
              updated_at = now()
          WHERE id = $1
        `,
        [args.conversationId],
      );

      const finalInvestigation = await client.query<InvestigationRow>(
        `
          UPDATE investigations
          SET state = $2,
              active_question_id = NULL,
              last_decision = $3,
              last_decision_reason = $4,
              updated_at = now()
          WHERE id = $1
          RETURNING *
        `,
        [locked.id, finalState, evaluation.decision, evaluation.reason],
      );

      return {
        investigation: finalInvestigation.rows[0],
        decision: evaluation.decision,
        state: finalState,
        activeQuestionId: null,
        shouldProceedToAnalysis: finalState === 'FINISHED_NO_QUESTION',
      };
    });
  }

  private async buildDeterministicQuestionTextForInvestigation(args: {
    client: PoolClient;
    patientId: string;
    eventFamily: InvestigationEventFamily;
    episodeId: string | null;
    conversationId: string;
    questionId: string;
    baseQuestionText: string;
  }): Promise<string> {
    const normalizedBaseQuestion = args.baseQuestionText.trim();
    if (args.eventFamily !== 'HYPO' || !args.episodeId || !normalizedBaseQuestion) {
      return normalizedBaseQuestion;
    }

    // The episode is described once, above the first question; the next questions follow without repeating it.
    const earlierQuestion = await args.client.query(
      `
        SELECT 1
        FROM messages
        WHERE conversation_id = $1
          AND message_type = 'CONTEXT_QUESTION'
          AND question_id IS DISTINCT FROM $2
        LIMIT 1
      `,
      [args.conversationId, args.questionId],
    );
    if (earlierQuestion.rows.length > 0) {
      return normalizedBaseQuestion;
    }

    const summary = await this.fetchHypoEpisodeQuestionSummary(args.client, args.patientId, args.episodeId);
    if (!summary || !summary.startedAtIso) {
      return normalizedBaseQuestion;
    }

    const prefix = buildHypoEpisodeQuestionPrefix({
      startedAtLabel: formatIsoToLocalHourMinute(summary.startedAtIso),
      isOngoing: summary.isOngoing,
      durationMinutes: summary.durationMinutes,
      minimumGlucoseMgdl: summary.minimumGlucoseMgdl,
    });
    if (!prefix) {
      return normalizedBaseQuestion;
    }

    return `${prefix}\n\n${normalizedBaseQuestion}`;
  }

  private async fetchHypoEpisodeQuestionSummary(client: PoolClient, patientId: string, episodeId: string): Promise<{
    startedAtIso: string | null;
    durationMinutes: number | null;
    minimumGlucoseMgdl: number | null;
    isOngoing: boolean;
  } | null> {
    const result = await client.query<{
      started_at: string | null;
      ended_at: string | null;
      latest_occurred_at: string | null;
      episode_state: string;
      minimum_glucose: string | null;
    }>(
      `
        SELECT
          e.started_at::text AS started_at,
          e.ended_at::text AS ended_at,
          latest.occurred_at::text AS latest_occurred_at,
          e.state AS episode_state,
          MIN(
            CASE
              WHEN COALESCE(glucose.payload->>'glucose_value', '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
                THEN (glucose.payload->>'glucose_value')::numeric
              WHEN COALESCE(glucose.payload->>'sgv', '') ~ '^-?[0-9]+(\\.[0-9]+)?$'
                THEN (glucose.payload->>'sgv')::numeric
              ELSE NULL
            END
          )::text AS minimum_glucose
        FROM hypo_episodes e
        LEFT JOIN events latest
          ON latest.id = e.latest_event_id
         AND latest.patient_id = e.patient_id
        LEFT JOIN events glucose
          ON glucose.patient_id = e.patient_id
         AND glucose.type = 'GLUCOSE_READING_AVAILABLE'
         AND glucose.occurred_at >= e.started_at
         AND glucose.occurred_at <= COALESCE(e.ended_at, latest.occurred_at, e.started_at)
        WHERE e.patient_id = $1
          AND e.id = $2
        GROUP BY e.started_at, e.ended_at, latest.occurred_at, e.state
        LIMIT 1
      `,
      [patientId, episodeId],
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    const startedAtMs = row.started_at ? Date.parse(row.started_at) : Number.NaN;
    const endedAtMs = row.ended_at ? Date.parse(row.ended_at) : Number.NaN;
    const durationMinutes = Number.isFinite(startedAtMs) && Number.isFinite(endedAtMs) && endedAtMs >= startedAtMs
      ? Math.max(1, Math.round((endedAtMs - startedAtMs) / 60_000))
      : null;

    const minRaw = row.minimum_glucose ? Number(row.minimum_glucose) : Number.NaN;
    const minimumGlucoseMgdl = Number.isFinite(minRaw) ? Math.round(minRaw) : null;
    const isOngoing = String(row.episode_state ?? '').toUpperCase() === 'OPEN' || !row.ended_at;

    return {
      startedAtIso: row.started_at,
      durationMinutes,
      minimumGlucoseMgdl,
      isOngoing,
    };
  }

  /** The hypo a conversation is about (its trigger event anchors the report facts); null for other conversations. */
  async getConversationHypo(patientId: string, conversationId: string): Promise<{
    episode_id: string;
    trigger_id: string;
    source_event_id: string;
    state: string;
    severity: string;
    started_at: string;
    ended_at: string | null;
    duration_minutes: number | null;
    minimum_glucose: number | null;
  } | null> {
    const result = await this.pool.query<{ episode_id: string; trigger_id: string; source_event_id: string; state: string; severity: string; started_at: Date | string; ended_at: Date | string | null }>(
      `
        SELECT e.id::text AS episode_id, e.trigger_id::text AS trigger_id, t.source_event_id::text AS source_event_id,
               e.state, e.severity, e.started_at, e.ended_at
        FROM conversations c
        JOIN hypo_episodes e ON e.id = c.episode_id AND e.patient_id = c.patient_id
        JOIN triggers t ON t.id = e.trigger_id
        WHERE c.patient_id = $1 AND c.id = $2
        LIMIT 1
      `,
      [patientId, conversationId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    const summary = await this.fetchHypoEpisodeQuestionSummary(this.pool as unknown as PoolClient, patientId, row.episode_id);
    const toIso = (value: Date | string | null) => (value === null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString());
    return {
      episode_id: row.episode_id,
      trigger_id: row.trigger_id,
      source_event_id: row.source_event_id,
      state: row.state,
      severity: row.severity,
      started_at: toIso(row.started_at) as string,
      ended_at: toIso(row.ended_at),
      duration_minutes: summary?.durationMinutes ?? null,
      minimum_glucose: summary?.minimumGlucoseMgdl ?? null,
    };
  }

  /** CGM readings of a window, oldest first (the hypo screen's chart). */
  async listGlucoseReadingsBetween(patientId: string, fromIso: string, toIso: string): Promise<Array<{ observed_at: string; glucose_mgdl: number }>> {
    const result = await this.pool.query<{ occurred_at: Date | string; glucose: string | null }>(
      `
        SELECT occurred_at,
               CASE
                 WHEN COALESCE(payload->>'glucose_value', '') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN payload->>'glucose_value'
                 WHEN COALESCE(payload->>'sgv', '') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN payload->>'sgv'
                 ELSE NULL
               END AS glucose
        FROM events
        WHERE patient_id = $1
          AND type = 'GLUCOSE_READING_AVAILABLE'
          AND occurred_at >= $2::timestamptz
          AND occurred_at <= $3::timestamptz
        ORDER BY occurred_at ASC
        LIMIT 500
      `,
      [patientId, fromIso, toIso],
    );
    return result.rows
      .map((row) => ({
        observed_at: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : new Date(row.occurred_at).toISOString(),
        glucose_mgdl: Math.round(Number(row.glucose)),
      }))
      .filter((reading) => Number.isFinite(reading.glucose_mgdl));
  }

  async markInvestigationClosed(args: { investigationId: string; state: 'RESOLVED' | 'CLOSED' }): Promise<void> {
    await this.pool.query(
      `
        UPDATE investigations
        SET state = $2,
            updated_at = now()
        WHERE id = $1
      `,
      [args.investigationId, args.state],
    );
  }

  async insertMessage(args: {
    conversationId: string;
    patientId: string;
    role: string;
    messageType: string;
    content: string;
    questionId: string | null;
    answerType: string | null;
    answerText: string | null;
    answerValue: boolean | null;
    provenanceRef: string;
    metadata?: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<Record<string, unknown>> {
    const result = await this.pool.query(
      `
        INSERT INTO messages (
          conversation_id, patient_id, role, message_type, content, question_id, answer_type, answer_text, answer_value, provenance_ref, metadata, idempotency_key
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
        ON CONFLICT (conversation_id, idempotency_key)
        DO UPDATE SET updated_at = now()
        RETURNING *
      `,
      [
        args.conversationId,
        args.patientId,
        args.role,
        args.messageType,
        args.content,
        args.questionId,
        args.answerType,
        args.answerText,
        args.answerValue,
        args.provenanceRef,
        JSON.stringify(args.metadata ?? {}),
        args.idempotencyKey,
      ],
    );

    return result.rows[0];
  }

  async setConversationAwaitingUserAnswer(args: { conversationId: string; awaitingUserAnswer: boolean }): Promise<void> {
    await this.pool.query(
      `
        UPDATE conversations
        SET awaiting_user_answer = $2,
            updated_at = now()
        WHERE id = $1
      `,
      [args.conversationId, args.awaitingUserAnswer],
    );
  }

  async insertContextPackage(args: {
    patientId: string;
    jobId: string;
    packageVersion: string;
    contentHash: string;
    payload: Record<string, unknown>;
    status: string;
  }): Promise<Record<string, unknown>> {
    const result = await this.pool.query(
      `
        INSERT INTO context_packages (
          patient_id, job_id, package_version, content_hash, payload, status
        ) VALUES ($1,$2,$3,$4,$5::jsonb,$6)
        ON CONFLICT (package_version, content_hash)
        DO UPDATE SET updated_at = now()
        RETURNING *
      `,
      [args.patientId, args.jobId, args.packageVersion, args.contentHash, JSON.stringify(args.payload), args.status],
    );

    return result.rows[0];
  }

  async getAiExecutionByTaskIdentity(taskIdentity: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(`SELECT * FROM ai_executions WHERE task_identity = $1 LIMIT 1`, [taskIdentity]);
    return result.rows[0] ?? null;
  }

  async openEvidenceSession(args: {
    taskIdentity: string;
    patientId: string;
    taskType: string;
    contextPackageId: string;
    contextPackageHash: string;
    initialEvidenceHash: string;
    initialEvidenceBytes: number;
    startedAt: string;
  }): Promise<{ sessionId: string } | null> {
    const opened = await this.pool.query<{ id: string }>(
      `
        INSERT INTO evidence_sessions (
          ai_execution_id,
          patient_id,
          task_type,
          context_package_id,
          context_package_hash,
          status,
          initial_evidence_hash,
          initial_evidence_bytes,
          created_at,
          updated_at,
          completed_at,
          failure
        )
        SELECT
          e.id,
          $2,
          $3,
          $4,
          $5,
          'RUNNING',
          $6,
          $7,
          $8::timestamptz,
          now(),
          NULL,
          NULL
        FROM ai_executions e
        WHERE e.task_identity = $1
          AND e.patient_id = $2
        ON CONFLICT (ai_execution_id)
        DO UPDATE SET
          status = 'RUNNING',
          context_package_id = EXCLUDED.context_package_id,
          context_package_hash = EXCLUDED.context_package_hash,
          initial_evidence_hash = EXCLUDED.initial_evidence_hash,
          initial_evidence_bytes = EXCLUDED.initial_evidence_bytes,
          completed_at = NULL,
          failure = NULL,
          updated_at = now()
        WHERE evidence_sessions.status <> 'COMPLETED'
        RETURNING id
      `,
      [
        args.taskIdentity,
        args.patientId,
        args.taskType,
        args.contextPackageId,
        args.contextPackageHash,
        args.initialEvidenceHash,
        Math.max(0, Math.trunc(args.initialEvidenceBytes)),
        args.startedAt,
      ],
    );

    if (opened.rows[0]?.id) {
      return { sessionId: opened.rows[0].id };
    }

    const existing = await this.pool.query<{ id: string }>(
      `
        SELECT s.id
        FROM evidence_sessions s
        JOIN ai_executions e ON e.id = s.ai_execution_id
        WHERE e.task_identity = $1
          AND s.patient_id = $2
        LIMIT 1
      `,
      [args.taskIdentity, args.patientId],
    );

    return existing.rows[0]?.id ? { sessionId: existing.rows[0].id } : null;
  }

  async recordEvidenceToolCallRequested(args: {
    taskIdentity: string;
    patientId: string;
    sequence: number;
    callId: string | null;
    toolName: string;
    requestHash: string;
    arguments: Record<string, unknown>;
    timeRange: { from: string; to: string } | null;
    detailLevel: string | null;
    requestedAt: string;
  }): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO evidence_session_tool_calls (
          session_id,
          sequence,
          call_id,
          tool_name,
          request_hash,
          arguments,
          patient_id,
          time_range,
          detail_level,
          status,
          requested_at,
          created_at,
          updated_at
        )
        SELECT
          s.id,
          $3,
          $4,
          $5,
          $6,
          $7::jsonb,
          $2,
          $8::jsonb,
          $9,
          'REQUESTED',
          $10::timestamptz,
          now(),
          now()
        FROM evidence_sessions s
        JOIN ai_executions e ON e.id = s.ai_execution_id
        WHERE e.task_identity = $1
          AND s.patient_id = $2
          AND s.status = 'RUNNING'
        ON CONFLICT (session_id, sequence)
        DO NOTHING
      `,
      [
        args.taskIdentity,
        args.patientId,
        args.sequence,
        args.callId,
        args.toolName,
        args.requestHash,
        JSON.stringify(args.arguments),
        args.timeRange ? JSON.stringify(args.timeRange) : null,
        args.detailLevel,
        args.requestedAt,
      ],
    );
  }

  async recordEvidenceToolCallSucceeded(args: {
    taskIdentity: string;
    patientId: string;
    sequence: number;
    resultStatus: string;
    resultHash: string;
    resultBytes: number;
    compilerVersion: string | null;
    evidenceVersion: string | null;
    provenanceRefs: string[];
    completedAt: string;
  }): Promise<void> {
    await this.pool.query(
      `
        UPDATE evidence_session_tool_calls c
        SET
          status = 'SUCCEEDED',
          result_status = $4,
          result_hash = $5,
          result_bytes = $6,
          compiler_version = $7,
          evidence_version = $8,
          provenance_refs = $9::jsonb,
          completed_at = $10::timestamptz,
          failure = NULL,
          updated_at = now()
        FROM evidence_sessions s
        JOIN ai_executions e ON e.id = s.ai_execution_id
        WHERE c.session_id = s.id
          AND e.task_identity = $1
          AND s.patient_id = $2
          AND c.sequence = $3
          AND c.status = 'REQUESTED'
          AND s.status = 'RUNNING'
      `,
      [
        args.taskIdentity,
        args.patientId,
        args.sequence,
        args.resultStatus,
        args.resultHash,
        Math.max(0, Math.trunc(args.resultBytes)),
        args.compilerVersion,
        args.evidenceVersion,
        JSON.stringify(args.provenanceRefs),
        args.completedAt,
      ],
    );
  }

  async recordEvidenceToolCallFailed(args: {
    taskIdentity: string;
    patientId: string;
    sequence: number;
    failure: Record<string, unknown>;
    completedAt: string;
  }): Promise<void> {
    await this.pool.query(
      `
        UPDATE evidence_session_tool_calls c
        SET
          status = 'FAILED',
          completed_at = $5::timestamptz,
          failure = $4::jsonb,
          updated_at = now()
        FROM evidence_sessions s
        JOIN ai_executions e ON e.id = s.ai_execution_id
        WHERE c.session_id = s.id
          AND e.task_identity = $1
          AND s.patient_id = $2
          AND c.sequence = $3
          AND c.status = 'REQUESTED'
          AND s.status = 'RUNNING'
      `,
      [
        args.taskIdentity,
        args.patientId,
        args.sequence,
        JSON.stringify(args.failure),
        args.completedAt,
      ],
    );
  }

  async completeEvidenceSession(args: {
    taskIdentity: string;
    patientId: string;
    completedAt: string;
  }): Promise<void> {
    await this.pool.query(
      `
        WITH target_session AS (
          SELECT s.id
          FROM evidence_sessions s
          JOIN ai_executions e ON e.id = s.ai_execution_id
          WHERE e.task_identity = $1
            AND s.patient_id = $2
            AND s.status = 'RUNNING'
          LIMIT 1
        ),
        aggregate_base AS (
          SELECT
            COALESCE(COUNT(*), 0)::integer AS tool_call_count,
            COALESCE(SUM(CASE WHEN c.status = 'SUCCEEDED' THEN 1 ELSE 0 END), 0)::integer AS successful_tool_call_count,
            COALESCE(SUM(CASE WHEN c.status = 'FAILED' THEN 1 ELSE 0 END), 0)::integer AS failed_tool_call_count,
            COALESCE(SUM(COALESCE(c.result_bytes, 0)), 0)::bigint AS total_tool_result_bytes
          FROM target_session t
          LEFT JOIN evidence_session_tool_calls c ON c.session_id = t.id
        ),
        aggregate_unique AS (
          SELECT
            COALESCE(SUM(x.result_bytes), 0)::bigint AS unique_tool_result_bytes
          FROM (
            SELECT DISTINCT ON (c.result_hash)
              COALESCE(c.result_bytes, 0)::bigint AS result_bytes,
              c.result_hash,
              c.sequence
            FROM target_session t
            JOIN evidence_session_tool_calls c ON c.session_id = t.id
            WHERE c.status = 'SUCCEEDED'
              AND c.result_hash IS NOT NULL
            ORDER BY c.result_hash, c.sequence
          ) x
        )
        UPDATE evidence_sessions s
        SET
          status = 'COMPLETED',
          completed_at = $3::timestamptz,
          tool_call_count = b.tool_call_count,
          successful_tool_call_count = b.successful_tool_call_count,
          failed_tool_call_count = b.failed_tool_call_count,
          total_tool_result_bytes = b.total_tool_result_bytes,
          unique_tool_result_bytes = u.unique_tool_result_bytes,
          duplicated_tool_result_bytes = GREATEST(0, b.total_tool_result_bytes - u.unique_tool_result_bytes),
          updated_at = now()
        FROM target_session t
        CROSS JOIN aggregate_base b
        CROSS JOIN aggregate_unique u
        WHERE s.id = t.id
      `,
      [args.taskIdentity, args.patientId, args.completedAt],
    );
  }

  async failEvidenceSession(args: {
    taskIdentity: string;
    patientId: string;
    failedAt: string;
    failure: Record<string, unknown>;
  }): Promise<void> {
    await this.pool.query(
      `
        WITH target_session AS (
          SELECT s.id
          FROM evidence_sessions s
          JOIN ai_executions e ON e.id = s.ai_execution_id
          WHERE e.task_identity = $1
            AND s.patient_id = $2
            AND s.status = 'RUNNING'
          LIMIT 1
        ),
        aggregate_base AS (
          SELECT
            COALESCE(COUNT(*), 0)::integer AS tool_call_count,
            COALESCE(SUM(CASE WHEN c.status = 'SUCCEEDED' THEN 1 ELSE 0 END), 0)::integer AS successful_tool_call_count,
            COALESCE(SUM(CASE WHEN c.status = 'FAILED' THEN 1 ELSE 0 END), 0)::integer AS failed_tool_call_count,
            COALESCE(SUM(COALESCE(c.result_bytes, 0)), 0)::bigint AS total_tool_result_bytes
          FROM target_session t
          LEFT JOIN evidence_session_tool_calls c ON c.session_id = t.id
        ),
        aggregate_unique AS (
          SELECT
            COALESCE(SUM(x.result_bytes), 0)::bigint AS unique_tool_result_bytes
          FROM (
            SELECT DISTINCT ON (c.result_hash)
              COALESCE(c.result_bytes, 0)::bigint AS result_bytes,
              c.result_hash,
              c.sequence
            FROM target_session t
            JOIN evidence_session_tool_calls c ON c.session_id = t.id
            WHERE c.status = 'SUCCEEDED'
              AND c.result_hash IS NOT NULL
            ORDER BY c.result_hash, c.sequence
          ) x
        )
        UPDATE evidence_sessions s
        SET
          status = 'FAILED',
          completed_at = $3::timestamptz,
          tool_call_count = b.tool_call_count,
          successful_tool_call_count = b.successful_tool_call_count,
          failed_tool_call_count = b.failed_tool_call_count,
          total_tool_result_bytes = b.total_tool_result_bytes,
          unique_tool_result_bytes = u.unique_tool_result_bytes,
          duplicated_tool_result_bytes = GREATEST(0, b.total_tool_result_bytes - u.unique_tool_result_bytes),
          failure = $4::jsonb,
          updated_at = now()
        FROM target_session t
        CROSS JOIN aggregate_base b
        CROSS JOIN aggregate_unique u
        WHERE s.id = t.id
      `,
      [args.taskIdentity, args.patientId, args.failedAt, JSON.stringify(args.failure)],
    );
  }

  async markAiExecutionRunning(args: { task: AiTask; taskIdentity: string; inputHash: string; nowIso: string }): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO ai_executions (
          task_identity, task_id, task_type, task_version, patient_id, trigger_id, analysis_id,
          context_package_id, context_package_version, context_package_hash,
          correlation_id, input_hash, prompt_version, output_schema_version, model_policy_version,
          status, started_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'running',$16::timestamptz)
        ON CONFLICT (task_identity)
        DO UPDATE SET
          status = 'running',
          started_at = EXCLUDED.started_at,
          processing_state = NULL,
          updated_at = now()
      `,
      [
        args.taskIdentity,
        args.task.task_id,
        args.task.task_type,
        args.task.task_version,
        args.task.patient_id ?? null,
        args.task.trigger_id ?? null,
        args.task.analysis_id ?? null,
        args.task.context_package_id,
        args.task.context_package_version,
        args.task.context_package_hash,
        args.task.correlation_id,
        args.inputHash,
        args.task.prompt_version,
        args.task.output_schema_version,
        args.task.model_policy_version,
        args.nowIso,
      ],
    );
  }

  async createAiExecutionAttempt(args: {
    taskIdentity: string;
    provider: string;
    model: string;
    startedAt: string;
  }): Promise<{ id: string; attempt_number: number }> {
    const execution = await this.pool.query<{ id: string }>(
      `SELECT id FROM ai_executions WHERE task_identity = $1 LIMIT 1`,
      [args.taskIdentity],
    );

    const executionId = execution.rows[0]?.id;
    if (!executionId) {
      throw new Error(`AI execution not found for task identity: ${args.taskIdentity}`);
    }

    const nextAttempt = await this.pool.query<{ next_attempt_number: string }>(
      `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_attempt_number
       FROM ai_execution_attempts
       WHERE ai_execution_id = $1`,
      [executionId],
    );

    const attemptNumber = Number(nextAttempt.rows[0]?.next_attempt_number ?? 1);

    const result = await this.pool.query<{ id: string; attempt_number: number }>(
      `
        INSERT INTO ai_execution_attempts (
          ai_execution_id, attempt_number, provider, model, started_at, status, created_at
        ) VALUES ($1, $2, $3, $4, $5::timestamptz, 'RUNNING', now())
        ON CONFLICT (ai_execution_id, attempt_number)
        DO NOTHING
        RETURNING id, attempt_number
      `,
      [executionId, attemptNumber, args.provider, args.model, args.startedAt],
    );

    if (result.rows[0]) {
      return { id: result.rows[0].id, attempt_number: Number(result.rows[0].attempt_number) };
    }

    const existing = await this.pool.query<{ id: string; attempt_number: number }>(
      `SELECT id, attempt_number FROM ai_execution_attempts WHERE ai_execution_id = $1 AND attempt_number = $2 LIMIT 1`,
      [executionId, attemptNumber],
    );

    return {
      id: existing.rows[0]?.id ?? executionId,
      attempt_number: Number(existing.rows[0]?.attempt_number ?? attemptNumber),
    };
  }

  async updateAiExecutionAttempt(args: {
    attemptId: string;
    provider: string;
    model: string;
    modelFingerprint?: string | null;
    inputFingerprint?: string | null;
    startedAt: string;
    completedAt?: string | null;
    providerLatencyMs?: number | null;
    status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
    usage?: AIUsage | null;
    estimatedCost?: AICostEstimate | null;
    errorType?: string | null;
    errorCode?: string | null;
  }): Promise<void> {
    await this.pool.query(
      `
        UPDATE ai_execution_attempts
        SET provider = $2,
            model = $3,
            model_fingerprint = $4,
            input_fingerprint = $5,
            started_at = $6::timestamptz,
            completed_at = COALESCE($7::timestamptz, completed_at),
            provider_latency_ms = $8,
            status = $9,
            error_type = $10,
            error_code = $11,
            input_tokens = $12,
            output_tokens = $13,
            total_tokens = $14,
            cached_input_tokens = $15,
            reasoning_tokens = $16,
            estimated_cost = $17,
            cost_currency = $18,
            pricing_version = $19
        WHERE id = $1
      `,
      [
        args.attemptId,
        args.provider,
        args.model,
        args.modelFingerprint ?? null,
        args.inputFingerprint ?? null,
        args.startedAt,
        args.completedAt ?? null,
        args.providerLatencyMs ?? null,
        args.status,
        args.errorType ?? null,
        args.errorCode ?? null,
        args.usage?.input_tokens ?? null,
        args.usage?.output_tokens ?? null,
        args.usage?.total_tokens ?? null,
        args.usage?.cached_input_tokens ?? null,
        args.usage?.reasoning_tokens ?? null,
        args.estimatedCost?.estimated_cost ?? null,
        args.estimatedCost?.currency ?? null,
        args.estimatedCost?.pricing_version ?? null,
      ],
    );
  }

  async markAiExecutionSucceeded(args: { taskIdentity: string; result: AiExecutionResult; nowIso: string }): Promise<void> {
    const cost = args.result.metadata.estimated_cost ?? null;
    const contextPackageUsage = args.result.metadata.context_package_usage ?? null;

    await this.pool.query(
      `
        UPDATE ai_executions
        SET provider = $2::text,
            model = $3::text,
            model_fingerprint = $4::text,
            status = 'succeeded',
            processing_state = NULL,
            normalized_result = $5::jsonb,
            error = NULL,
            completed_at = $6::timestamptz,
            failed_at = NULL,
            input_fingerprint = $7::text,
            serialized_input_bytes = $8::bigint,
            provider_latency_ms = $9::integer,
            input_tokens = (
              WITH execution AS (
                SELECT id FROM ai_executions WHERE task_identity = $1 LIMIT 1
              )
              SELECT CASE
                WHEN EXISTS (
                  SELECT 1 FROM ai_execution_attempts a
                  JOIN execution e ON e.id = a.ai_execution_id
                  WHERE a.status = 'SUCCEEDED' AND a.input_tokens IS NULL
                ) THEN NULL
                ELSE (
                  SELECT SUM(a.input_tokens)
                  FROM ai_execution_attempts a
                  JOIN execution e ON e.id = a.ai_execution_id
                  WHERE a.status = 'SUCCEEDED' AND a.input_tokens IS NOT NULL
                )
              END
            ),
            output_tokens = (
              WITH execution AS (
                SELECT id FROM ai_executions WHERE task_identity = $1 LIMIT 1
              )
              SELECT CASE
                WHEN EXISTS (
                  SELECT 1 FROM ai_execution_attempts a
                  JOIN execution e ON e.id = a.ai_execution_id
                  WHERE a.status = 'SUCCEEDED' AND a.output_tokens IS NULL
                ) THEN NULL
                ELSE (
                  SELECT SUM(a.output_tokens)
                  FROM ai_execution_attempts a
                  JOIN execution e ON e.id = a.ai_execution_id
                  WHERE a.status = 'SUCCEEDED' AND a.output_tokens IS NOT NULL
                )
              END
            ),
            total_tokens = (
              WITH execution AS (
                SELECT id FROM ai_executions WHERE task_identity = $1 LIMIT 1
              )
              SELECT CASE
                WHEN EXISTS (
                  SELECT 1 FROM ai_execution_attempts a
                  JOIN execution e ON e.id = a.ai_execution_id
                  WHERE a.status = 'SUCCEEDED' AND a.total_tokens IS NULL
                ) THEN NULL
                ELSE (
                  SELECT SUM(a.total_tokens)
                  FROM ai_execution_attempts a
                  JOIN execution e ON e.id = a.ai_execution_id
                  WHERE a.status = 'SUCCEEDED' AND a.total_tokens IS NOT NULL
                )
              END
            ),
            cached_input_tokens = (
              WITH execution AS (
                SELECT id FROM ai_executions WHERE task_identity = $1 LIMIT 1
              )
              SELECT CASE
                WHEN EXISTS (
                  SELECT 1 FROM ai_execution_attempts a
                  JOIN execution e ON e.id = a.ai_execution_id
                  WHERE a.status = 'SUCCEEDED' AND a.cached_input_tokens IS NULL
                ) THEN NULL
                ELSE (
                  SELECT SUM(a.cached_input_tokens)
                  FROM ai_execution_attempts a
                  JOIN execution e ON e.id = a.ai_execution_id
                  WHERE a.status = 'SUCCEEDED' AND a.cached_input_tokens IS NOT NULL
                )
              END
            ),
            reasoning_tokens = (
              WITH execution AS (
                SELECT id FROM ai_executions WHERE task_identity = $1 LIMIT 1
              )
              SELECT CASE
                WHEN EXISTS (
                  SELECT 1 FROM ai_execution_attempts a
                  JOIN execution e ON e.id = a.ai_execution_id
                  WHERE a.status = 'SUCCEEDED' AND a.reasoning_tokens IS NULL
                ) THEN NULL
                ELSE (
                  SELECT SUM(a.reasoning_tokens)
                  FROM ai_execution_attempts a
                  JOIN execution e ON e.id = a.ai_execution_id
                  WHERE a.status = 'SUCCEEDED' AND a.reasoning_tokens IS NOT NULL
                )
              END
            ),
            context_package_usage = $10::jsonb,
            estimated_cost = (
              WITH execution AS (
                SELECT id FROM ai_executions WHERE task_identity = $1 LIMIT 1
              ),
              attempts AS (
                SELECT a.*
                FROM ai_execution_attempts a
                JOIN execution e ON e.id = a.ai_execution_id
                WHERE a.status IN ('SUCCEEDED', 'FAILED')
              ),
              billable_attempts AS (
                SELECT *
                FROM attempts
                WHERE input_tokens IS NOT NULL
                   OR output_tokens IS NOT NULL
                   OR total_tokens IS NOT NULL
                   OR cached_input_tokens IS NOT NULL
                   OR reasoning_tokens IS NOT NULL
              )
              SELECT CASE
                WHEN EXISTS (
                  SELECT 1 FROM billable_attempts WHERE estimated_cost IS NULL
                ) THEN NULL
                WHEN EXISTS (
                  SELECT 1 FROM attempts WHERE estimated_cost IS NOT NULL
                ) THEN (
                  SELECT SUM(estimated_cost)
                  FROM attempts
                  WHERE estimated_cost IS NOT NULL
                )
                ELSE $11::numeric
              END
            ),
            cost_currency = (
              WITH execution AS (
                SELECT id FROM ai_executions WHERE task_identity = $1 LIMIT 1
              ),
              attempts AS (
                SELECT a.*
                FROM ai_execution_attempts a
                JOIN execution e ON e.id = a.ai_execution_id
                WHERE a.status IN ('SUCCEEDED', 'FAILED')
              ),
              billable_attempts AS (
                SELECT *
                FROM attempts
                WHERE input_tokens IS NOT NULL
                   OR output_tokens IS NOT NULL
                   OR total_tokens IS NOT NULL
                   OR cached_input_tokens IS NOT NULL
                   OR reasoning_tokens IS NOT NULL
              )
              SELECT CASE
                WHEN EXISTS (
                  SELECT 1 FROM billable_attempts WHERE estimated_cost IS NULL
                ) THEN NULL
                WHEN EXISTS (
                  SELECT 1 FROM attempts WHERE estimated_cost IS NOT NULL
                ) THEN (
                  SELECT CASE
                    WHEN COUNT(DISTINCT cost_currency) = 1 THEN MIN(cost_currency)
                    ELSE NULL
                  END
                  FROM attempts
                  WHERE estimated_cost IS NOT NULL
                    AND cost_currency IS NOT NULL
                )
                ELSE $12::text
              END
            ),
            pricing_version = (
              WITH execution AS (
                SELECT id FROM ai_executions WHERE task_identity = $1 LIMIT 1
              ),
              attempts AS (
                SELECT a.*
                FROM ai_execution_attempts a
                JOIN execution e ON e.id = a.ai_execution_id
                WHERE a.status IN ('SUCCEEDED', 'FAILED')
              ),
              billable_attempts AS (
                SELECT *
                FROM attempts
                WHERE input_tokens IS NOT NULL
                   OR output_tokens IS NOT NULL
                   OR total_tokens IS NOT NULL
                   OR cached_input_tokens IS NOT NULL
                   OR reasoning_tokens IS NOT NULL
              )
              SELECT CASE
                WHEN EXISTS (
                  SELECT 1 FROM billable_attempts WHERE estimated_cost IS NULL
                ) THEN NULL
                WHEN EXISTS (
                  SELECT 1 FROM attempts WHERE estimated_cost IS NOT NULL
                ) THEN (
                  SELECT CASE
                    WHEN COUNT(DISTINCT pricing_version) = 1 THEN MIN(pricing_version)
                    ELSE NULL
                  END
                  FROM attempts
                  WHERE estimated_cost IS NOT NULL
                    AND pricing_version IS NOT NULL
                )
                ELSE $13::text
              END
            ),
            updated_at = now()
        WHERE task_identity = $1
      `,
      [
        args.taskIdentity,
        args.result.metadata.provider,
        args.result.metadata.model,
        args.result.metadata.model_fingerprint,
        JSON.stringify(args.result),
        args.nowIso,
        args.result.metadata.input_fingerprint ?? null,
        args.result.metadata.serialized_input_bytes ?? null,
        args.result.metadata.provider_latency_ms ?? null,
        contextPackageUsage ? JSON.stringify(contextPackageUsage) : null,
        cost ? cost.estimated_cost : null,
        cost ? cost.currency : null,
        cost ? cost.pricing_version : null,
      ],
    );
  }

  /**
   * Cancels the analysis answering one user message (see user-message-cancellation.ts). Runs under row locks on
   * the message and its newest job, so it serializes with claimUserMessageCompletion and job claiming.
   */
  async cancelUserMessageResponse(args: {
    patientId: string;
    conversationId: string;
    userMessageId: string;
    cancelledBy: string;
    nowIso: string;
  }): Promise<{ outcome: UserMessageCancellationOutcome; job_status: string | null } | null> {
    return this.withTransaction(async (client) => {
      const message = (await client.query(
        `
          SELECT id, metadata
          FROM messages
          WHERE id = $1::uuid AND conversation_id = $2::uuid AND patient_id = $3::uuid
            AND role = 'USER' AND message_type = 'USER_MESSAGE'
          FOR UPDATE
        `,
        [args.userMessageId, args.conversationId, args.patientId],
      )).rows[0];
      if (!message) {
        return null;
      }

      const job = (await client.query(
        `
          SELECT id, status FROM jobs
          WHERE correlation_id = $1::uuid
            AND job_type = ANY($2::text[])
            AND payload->>'user_message_id' = $3
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE
        `,
        [args.conversationId, [...CANCELLABLE_ANALYSIS_JOB_TYPES], args.userMessageId],
      )).rows[0];
      const hasReply = (await client.query(
        `SELECT 1 FROM messages WHERE conversation_id = $1::uuid AND role = 'ASSISTANT' AND metadata->>'user_message_id' = $2 LIMIT 1`,
        [args.conversationId, args.userMessageId],
      )).rows.length > 0;

      const decision = decideUserMessageCancellation({
        response_state: parseUserMessageResponseState(message.metadata),
        has_assistant_reply: hasReply,
        job_status: job ? String(job.status) : null,
      });
      if (decision.outcome !== 'CANCELLED') {
        return { outcome: decision.outcome, job_status: job ? String(job.status) : null };
      }

      await client.query(
        `
          UPDATE messages
          SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                'response_state', 'CANCELLED',
                'cancelled_at', $2::text,
                'cancelled_by', $3::text
              ),
              updated_at = now()
          WHERE id = $1::uuid
        `,
        [args.userMessageId, args.nowIso, args.cancelledBy],
      );

      let jobStatus = String(job.status);
      if (decision.job_action === 'CANCEL_QUEUED_JOB') {
        await client.query(
          `UPDATE jobs SET status = 'cancelled', completed_at = $2::timestamptz, updated_at = now() WHERE id = $1 AND status = 'queued'`,
          [job.id, args.nowIso],
        );
        jobStatus = 'cancelled';
      }

      // Hide the in-flight processing state right away; the worker records the final cancelled state itself.
      await client.query(
        `
          UPDATE ai_executions
          SET status = 'cancelled', processing_state = NULL, completed_at = COALESCE(completed_at, $3::timestamptz), updated_at = now()
          WHERE patient_id = $1 AND correlation_id = $2 AND status = 'running'
        `,
        [args.patientId, args.conversationId, args.nowIso],
      );

      return { outcome: 'CANCELLED', job_status: jobStatus };
    });
  }

  /**
   * Worker side of the race: atomically marks the message COMPLETING unless it was cancelled. Returns false when
   * the message is cancelled (the result must then be discarded). Repeating it after a crash returns true.
   */
  async claimUserMessageCompletion(conversationId: string, userMessageId: string): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE messages
        SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('response_state', 'COMPLETING'),
            updated_at = now()
        WHERE id = $1::uuid AND conversation_id = $2::uuid
          AND COALESCE(metadata->>'response_state', '') <> 'CANCELLED'
        RETURNING id
      `,
      [userMessageId, conversationId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async isUserMessageCancelled(conversationId: string, userMessageId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT metadata->>'response_state' AS response_state FROM messages WHERE id = $1::uuid AND conversation_id = $2::uuid`,
      [userMessageId, conversationId],
    );
    return result.rows[0]?.response_state === 'CANCELLED';
  }

  async markAiExecutionCancelled(args: { taskIdentity: string; nowIso: string }): Promise<void> {
    await this.pool.query(
      `
        UPDATE ai_executions
        SET status = 'cancelled', processing_state = NULL, completed_at = COALESCE(completed_at, $2::timestamptz), updated_at = now()
        WHERE task_identity = $1 AND status IN ('running', 'failed', 'cancelled')
      `,
      [args.taskIdentity, args.nowIso],
    );
  }

  async markAiExecutionFailed(args: { taskIdentity: string; error: Record<string, unknown>; nowIso: string }): Promise<void> {
    await this.pool.query(
      `
        UPDATE ai_executions
        SET status = 'failed',
            error = $2::jsonb,
            failed_at = $3::timestamptz,
            input_tokens = (
              WITH execution AS (
                SELECT id FROM ai_executions WHERE task_identity = $1 LIMIT 1
              )
              SELECT CASE
                WHEN EXISTS (
                  SELECT 1 FROM ai_execution_attempts a
                  JOIN execution e ON e.id = a.ai_execution_id
                  WHERE a.status = 'SUCCEEDED' AND a.input_tokens IS NULL
                ) THEN NULL
                ELSE (
                  SELECT SUM(a.input_tokens)
                  FROM ai_execution_attempts a
                  JOIN execution e ON e.id = a.ai_execution_id
                  WHERE a.status = 'SUCCEEDED' AND a.input_tokens IS NOT NULL
                )
              END
            ),
            output_tokens = (
              WITH execution AS (
                SELECT id FROM ai_executions WHERE task_identity = $1 LIMIT 1
              )
              SELECT CASE
                WHEN EXISTS (
                  SELECT 1 FROM ai_execution_attempts a
                  JOIN execution e ON e.id = a.ai_execution_id
                  WHERE a.status = 'SUCCEEDED' AND a.output_tokens IS NULL
                ) THEN NULL
                ELSE (
                  SELECT SUM(a.output_tokens)
                  FROM ai_execution_attempts a
                  JOIN execution e ON e.id = a.ai_execution_id
                  WHERE a.status = 'SUCCEEDED' AND a.output_tokens IS NOT NULL
                )
              END
            ),
            total_tokens = (
              WITH execution AS (
                SELECT id FROM ai_executions WHERE task_identity = $1 LIMIT 1
              )
              SELECT CASE
                WHEN EXISTS (
                  SELECT 1 FROM ai_execution_attempts a
                  JOIN execution e ON e.id = a.ai_execution_id
                  WHERE a.status = 'SUCCEEDED' AND a.total_tokens IS NULL
                ) THEN NULL
                ELSE (
                  SELECT SUM(a.total_tokens)
                  FROM ai_execution_attempts a
                  JOIN execution e ON e.id = a.ai_execution_id
                  WHERE a.status = 'SUCCEEDED' AND a.total_tokens IS NOT NULL
                )
              END
            ),
            cached_input_tokens = (
              WITH execution AS (
                SELECT id FROM ai_executions WHERE task_identity = $1 LIMIT 1
              )
              SELECT CASE
                WHEN EXISTS (
                  SELECT 1 FROM ai_execution_attempts a
                  JOIN execution e ON e.id = a.ai_execution_id
                  WHERE a.status = 'SUCCEEDED' AND a.cached_input_tokens IS NULL
                ) THEN NULL
                ELSE (
                  SELECT SUM(a.cached_input_tokens)
                  FROM ai_execution_attempts a
                  JOIN execution e ON e.id = a.ai_execution_id
                  WHERE a.status = 'SUCCEEDED' AND a.cached_input_tokens IS NOT NULL
                )
              END
            ),
            reasoning_tokens = (
              WITH execution AS (
                SELECT id FROM ai_executions WHERE task_identity = $1 LIMIT 1
              )
              SELECT CASE
                WHEN EXISTS (
                  SELECT 1 FROM ai_execution_attempts a
                  JOIN execution e ON e.id = a.ai_execution_id
                  WHERE a.status = 'SUCCEEDED' AND a.reasoning_tokens IS NULL
                ) THEN NULL
                ELSE (
                  SELECT SUM(a.reasoning_tokens)
                  FROM ai_execution_attempts a
                  JOIN execution e ON e.id = a.ai_execution_id
                  WHERE a.status = 'SUCCEEDED' AND a.reasoning_tokens IS NOT NULL
                )
              END
            ),
            estimated_cost = (
              WITH execution AS (
                SELECT id FROM ai_executions WHERE task_identity = $1 LIMIT 1
              ),
              attempts AS (
                SELECT a.*
                FROM ai_execution_attempts a
                JOIN execution e ON e.id = a.ai_execution_id
                WHERE a.status IN ('SUCCEEDED', 'FAILED')
              ),
              billable_attempts AS (
                SELECT *
                FROM attempts
                WHERE input_tokens IS NOT NULL
                   OR output_tokens IS NOT NULL
                   OR total_tokens IS NOT NULL
                   OR cached_input_tokens IS NOT NULL
                   OR reasoning_tokens IS NOT NULL
              )
              SELECT CASE
                WHEN EXISTS (
                  SELECT 1 FROM billable_attempts WHERE estimated_cost IS NULL
                ) THEN NULL
                ELSE (
                  SELECT SUM(estimated_cost)
                  FROM attempts
                  WHERE estimated_cost IS NOT NULL
                )
              END
            ),
            cost_currency = (
              WITH execution AS (
                SELECT id FROM ai_executions WHERE task_identity = $1 LIMIT 1
              ),
              attempts AS (
                SELECT a.*
                FROM ai_execution_attempts a
                JOIN execution e ON e.id = a.ai_execution_id
                WHERE a.status IN ('SUCCEEDED', 'FAILED')
              ),
              billable_attempts AS (
                SELECT *
                FROM attempts
                WHERE input_tokens IS NOT NULL
                   OR output_tokens IS NOT NULL
                   OR total_tokens IS NOT NULL
                   OR cached_input_tokens IS NOT NULL
                   OR reasoning_tokens IS NOT NULL
              )
              SELECT CASE
                WHEN EXISTS (
                  SELECT 1 FROM billable_attempts WHERE estimated_cost IS NULL
                ) THEN NULL
                ELSE (
                  SELECT CASE
                    WHEN COUNT(DISTINCT cost_currency) = 1 THEN MIN(cost_currency)
                    ELSE NULL
                  END
                  FROM attempts
                  WHERE estimated_cost IS NOT NULL
                    AND cost_currency IS NOT NULL
                )
              END
            ),
            pricing_version = (
              WITH execution AS (
                SELECT id FROM ai_executions WHERE task_identity = $1 LIMIT 1
              ),
              attempts AS (
                SELECT a.*
                FROM ai_execution_attempts a
                JOIN execution e ON e.id = a.ai_execution_id
                WHERE a.status IN ('SUCCEEDED', 'FAILED')
              ),
              billable_attempts AS (
                SELECT *
                FROM attempts
                WHERE input_tokens IS NOT NULL
                   OR output_tokens IS NOT NULL
                   OR total_tokens IS NOT NULL
                   OR cached_input_tokens IS NOT NULL
                   OR reasoning_tokens IS NOT NULL
              )
              SELECT CASE
                WHEN EXISTS (
                  SELECT 1 FROM billable_attempts WHERE estimated_cost IS NULL
                ) THEN NULL
                ELSE (
                  SELECT CASE
                    WHEN COUNT(DISTINCT pricing_version) = 1 THEN MIN(pricing_version)
                    ELSE NULL
                  END
                  FROM attempts
                  WHERE estimated_cost IS NOT NULL
                    AND pricing_version IS NOT NULL
                )
              END
            ),
            updated_at = now()
        WHERE task_identity = $1
      `,
      [args.taskIdentity, JSON.stringify(args.error), args.nowIso],
    );
  }

  async updateAiExecutionProcessingStep(args: {
    taskIdentity: string;
    step: Record<string, unknown>;
    status: 'PROCESSING' | 'FAILED';
  }): Promise<void> {
    await this.pool.query(
      `
        UPDATE ai_executions
        SET status = CASE WHEN $3 = 'FAILED' THEN 'failed' ELSE status END,
            processing_state = jsonb_build_object(
              'status', $3,
              'current_step', $2::jsonb,
              'steps', jsonb_build_array($2::jsonb)
            ),
            updated_at = now(),
            failed_at = CASE WHEN $3 = 'FAILED' THEN now() ELSE failed_at END
        WHERE task_identity = $1
      `,
      [args.taskIdentity, JSON.stringify(args.step), args.status],
    );
  }

  async linkAiExecutionToAnalysis(args: { taskIdentity: string; analysisId: string; nowIso: string }): Promise<void> {
    await this.pool.query(
      `
        UPDATE ai_executions
        SET analysis_id = $2,
            status = CASE WHEN status = 'running' THEN 'succeeded' ELSE status END,
            updated_at = now(),
            completed_at = COALESCE(completed_at, $3::timestamptz)
        WHERE task_identity = $1
      `,
      [args.taskIdentity, args.analysisId, args.nowIso],
    );
  }

  async insertJob(input: {
    jobType: string;
    payloadVersion: number;
    payload: Record<string, unknown>;
    dedupeKey: string;
    correlationId: string;
    causationId: string | null;
    patientId: string | null;
    availableAt: string;
    maxAttempts: number;
  }, txClient?: PoolClient): Promise<JobRecord> {
    const queryable = txClient ?? this.pool;
    const result = await queryable.query<JobRecord>(
      `
        INSERT INTO jobs (
          job_type, status, payload_version, payload, dedupe_key, correlation_id, causation_id, patient_id, available_at, max_attempts
        ) VALUES ($1,'queued',$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (job_type, dedupe_key)
        DO UPDATE SET updated_at = now()
        RETURNING *
      `,
      [
        input.jobType,
        input.payloadVersion,
        input.payload,
        input.dedupeKey,
        input.correlationId,
        input.causationId,
        input.patientId,
        input.availableAt,
        input.maxAttempts,
      ],
    );

    return result.rows[0];
  }

  async withTransaction<T>(handler: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await handler(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** allowedJobTypes restricts claiming to these types; other jobs are not read or changed. null/undefined: all types. */
  /** `excludedJobTypes`: types another lane of the same worker claims (the Nightscout sync lane). */
  async claimNextJob(workerId: string, nowIso: string, leaseSeconds: number, allowedJobTypes?: readonly string[] | null, excludedJobTypes?: readonly string[] | null): Promise<JobClaim | null> {
    if (allowedJobTypes && allowedJobTypes.length === 0) {
      throw new Error('claimNextJob: allowedJobTypes must not be empty when provided');
    }
    const allowed = allowedJobTypes ? [...allowedJobTypes] : null;
    const excluded = excludedJobTypes && excludedJobTypes.length > 0 ? [...excludedJobTypes] : null;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // A job whose lease expired with no attempts left (its last attempt probably ended the worker process) fails
      // instead of being claimed again without end.
      const exhausted = await client.query<{ id: string }>(
        `
          UPDATE jobs
          SET status = 'failed',
              failed_at = $1::timestamptz,
              last_error = jsonb_build_object('error', 'LEASE_EXPIRED_NO_ATTEMPTS_LEFT', 'job_type', job_type, 'retryable', false),
              updated_at = now()
          WHERE id IN (
            SELECT id
            FROM jobs
            WHERE status = 'running'
              AND lock_expires_at < $1::timestamptz
              AND attempts >= max_attempts
              AND ($2::text[] IS NULL OR job_type = ANY($2::text[]))
              AND ($3::text[] IS NULL OR job_type <> ALL($3::text[]))
            FOR UPDATE SKIP LOCKED
          )
          RETURNING id
        `,
        [nowIso, allowed, excluded],
      );
      for (const row of exhausted.rows ?? []) {
        this.logger.warn(`JOB_LEASE_EXPIRED_NO_ATTEMPTS_LEFT job_id=${row.id}`);
      }

      const result = await client.query<JobRecord>(
        `
          SELECT *
          FROM jobs
          WHERE (
            (status = 'queued' AND available_at <= $1::timestamptz)
            OR (status = 'running' AND lock_expires_at < $1::timestamptz AND attempts < max_attempts)
          )
            AND ($6::text[] IS NULL OR job_type = ANY($6::text[]))
            AND ($7::text[] IS NULL OR job_type <> ALL($7::text[]))
          ORDER BY
            CASE
              WHEN job_type = 'nightscout.sync'
                AND available_at <= ($1::timestamptz - make_interval(secs => $2::int))
                AND (
                  SELECT COUNT(*)
                  FROM jobs older
                  WHERE (
                    (older.status = 'queued' AND older.available_at <= $1::timestamptz)
                    OR (older.status = 'running' AND older.lock_expires_at < $1::timestamptz)
                  )
                    AND (
                      older.available_at < jobs.available_at
                      OR (older.available_at = jobs.available_at AND older.created_at < jobs.created_at)
                    )
                ) >= $3::int
              THEN 0
              WHEN job_type = ANY($4::text[])
                AND (
                  SELECT COUNT(*)
                  FROM jobs older
                  WHERE (
                    (older.status = 'queued' AND older.available_at <= $1::timestamptz)
                    OR (older.status = 'running' AND older.lock_expires_at < $1::timestamptz)
                  )
                    AND older.job_type = ANY($4::text[])
                    AND (
                      older.available_at < jobs.available_at
                      OR (older.available_at = jobs.available_at AND older.created_at < jobs.created_at)
                    )
                ) < $5::int
              THEN 1
              WHEN job_type <> ALL($4::text[])
              THEN 2
              ELSE 3
            END ASC,
            available_at ASC,
            created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        `,
        [
          nowIso,
          NIGHTSCOUT_STARVATION_AGE_SECONDS,
          NIGHTSCOUT_STARVATION_AHEAD_THRESHOLD,
          INTERACTIVE_JOB_TYPES,
          INTERACTIVE_FAIRNESS_WINDOW,
          allowed,
          excluded,
        ],
      );

      const job = result.rows[0];
      if (!job) {
        await client.query('COMMIT');
        return null;
      }

      const attempts = job.attempts + 1;
      const leaseToken = cryptoRandomUuid();
      const lockExpiresAt = new Date(Date.parse(nowIso) + leaseSeconds * 1000).toISOString();

      const updated = await client.query<JobRecord>(
        `
          UPDATE jobs
          SET status = 'running',
              attempts = $2,
              locked_at = $1::timestamptz,
              lock_expires_at = $3::timestamptz,
              locked_by = $4,
              lease_token = $5,
              updated_at = now()
          WHERE id = $6
          RETURNING *
        `,
        [nowIso, attempts, lockExpiresAt, workerId, leaseToken, job.id],
      );

      await client.query('COMMIT');

      const claimed = updated.rows[0];
      if (!claimed) {
        return null;
      }

      return {
        id: claimed.id,
        lease_token: String(claimed.lease_token),
        job_type: claimed.job_type,
        payload_version: claimed.payload_version,
        payload: claimed.payload as Record<string, unknown>,
        correlation_id: String(claimed.correlation_id),
        causation_id: claimed.causation_id ? String(claimed.causation_id) : null,
        patient_id: claimed.patient_id ? String(claimed.patient_id) : null,
        attempts: claimed.attempts,
        max_attempts: claimed.max_attempts,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async finalizeJobSuccess(jobId: string, leaseToken: string, nowIso: string): Promise<JobFinalizeResult> {
    const result = await this.pool.query(
      `
        UPDATE jobs
        SET status = 'succeeded',
            completed_at = $3::timestamptz,
            updated_at = now()
        WHERE id = $1
          AND lease_token = $2
          AND status = 'running'
          AND lock_expires_at >= $3::timestamptz
      `,
      [jobId, leaseToken, nowIso],
    );

    const rowCount = result.rowCount ?? 0;
    if (rowCount === 0) {
      this.logger.warn(`JOB_FINALIZE_LEASE_LOST finalize=success job_id=${jobId} row_count=0`);
    }

    return {
      rowCount,
      ownershipLost: rowCount === 0,
    };
  }

  /** A running job whose user message was cancelled: ends it as cancelled (never retried, never claimed again). */
  async finalizeJobCancelled(jobId: string, leaseToken: string, nowIso: string): Promise<JobFinalizeResult> {
    const result = await this.pool.query(
      `
        UPDATE jobs
        SET status = 'cancelled',
            completed_at = $3::timestamptz,
            locked_at = NULL,
            lock_expires_at = NULL,
            locked_by = NULL,
            lease_token = NULL,
            updated_at = now()
        WHERE id = $1
          AND lease_token = $2
          AND status = 'running'
        RETURNING id
      `,
      [jobId, leaseToken, nowIso],
    );
    const rowCount = result.rowCount ?? 0;
    if (rowCount === 0) {
      this.logger.warn(`JOB_FINALIZE_LEASE_LOST finalize=cancelled job_id=${jobId} row_count=0`);
    }
    return { rowCount, ownershipLost: rowCount === 0 };
  }

  async finalizeJobRetry(jobId: string, leaseToken: string, nowIso: string, nextAvailableAt: string, lastError: Record<string, unknown>): Promise<JobFinalizeResult> {
    const result = await this.pool.query(
      `
        UPDATE jobs
        SET status = 'queued',
            available_at = $4::timestamptz,
            locked_at = NULL,
            lock_expires_at = NULL,
            locked_by = NULL,
            lease_token = NULL,
            last_error = $5::jsonb,
            updated_at = now()
        WHERE id = $1
          AND lease_token = $2
          AND status = 'running'
          AND lock_expires_at >= $3::timestamptz
      `,
      [jobId, leaseToken, nowIso, nextAvailableAt, lastError],
    );

    const rowCount = result.rowCount ?? 0;
    if (rowCount === 0) {
      this.logger.warn(`JOB_FINALIZE_LEASE_LOST finalize=retry job_id=${jobId} row_count=0`);
    }

    return {
      rowCount,
      ownershipLost: rowCount === 0,
    };
  }

  /**
   * Hands a running job back to the queue untouched (worker shutdown): available now, and the claim's attempt is
   * returned so a restart does not count against max_attempts.
   */
  async releaseJobLease(jobId: string, leaseToken: string, nowIso: string): Promise<JobFinalizeResult> {
    const result = await this.pool.query(
      `
        UPDATE jobs
        SET status = 'queued',
            available_at = $3::timestamptz,
            attempts = GREATEST(attempts - 1, 0),
            locked_at = NULL,
            lock_expires_at = NULL,
            locked_by = NULL,
            lease_token = NULL,
            updated_at = now()
        WHERE id = $1
          AND lease_token = $2
          AND status = 'running'
      `,
      [jobId, leaseToken, nowIso],
    );

    const rowCount = result.rowCount ?? 0;
    if (rowCount === 0) {
      this.logger.warn(`JOB_FINALIZE_LEASE_LOST finalize=release job_id=${jobId} row_count=0`);
    }

    return { rowCount, ownershipLost: rowCount === 0 };
  }

  /** Status of the job with this dedupe key (queued, running, succeeded, failed, cancelled), or null when none exists. */
  async getJobStatusByDedupeKey(jobType: string, dedupeKey: string): Promise<string | null> {
    const result = await this.pool.query<{ status: string }>(
      `SELECT status FROM jobs WHERE job_type = $1 AND dedupe_key = $2`,
      [jobType, dedupeKey],
    );
    return result.rows[0]?.status ?? null;
  }

  /**
   * Puts the failed answer job of one caregiver message back in the queue (Ponów próbę in a conversation). Conversation
   * jobs are deduplicated by their range, so the job is found by its user message. False when nothing failed.
   */
  async requeueFailedConversationResponse(args: { patientId: string; conversationId: string; userMessageId: string }): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE jobs
        SET status = 'queued',
            attempts = 0,
            available_at = now(),
            failed_at = NULL,
            last_error = NULL,
            locked_at = NULL,
            lock_expires_at = NULL,
            locked_by = NULL,
            lease_token = NULL,
            updated_at = now()
        WHERE patient_id = $1
          AND correlation_id = $2
          AND job_type = ANY($4::text[])
          AND payload->>'user_message_id' = $3
          AND status = 'failed'
      `,
      [args.patientId, args.conversationId, args.userMessageId, [...CONVERSATION_RESPONSE_JOB_TYPES]],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Puts a failed job back in the queue (a caregiver asked to try again). False when it is not failed. */
  async requeueFailedJob(jobType: string, dedupeKey: string): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE jobs
        SET status = 'queued',
            attempts = 0,
            available_at = now(),
            failed_at = NULL,
            last_error = NULL,
            updated_at = now()
        WHERE job_type = $1 AND dedupe_key = $2 AND status = 'failed'
      `,
      [jobType, dedupeKey],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async finalizeJobFailure(jobId: string, leaseToken: string, nowIso: string, lastError: Record<string, unknown>): Promise<JobFinalizeResult> {
    const result = await this.pool.query(
      `
        UPDATE jobs
        SET status = 'failed',
            failed_at = $3::timestamptz,
            last_error = $4::jsonb,
            updated_at = now()
        WHERE id = $1
          AND lease_token = $2
          AND status = 'running'
          AND lock_expires_at >= $3::timestamptz
      `,
      [jobId, leaseToken, nowIso, lastError],
    );

    const rowCount = result.rowCount ?? 0;
    if (rowCount === 0) {
      this.logger.warn(`JOB_FINALIZE_LEASE_LOST finalize=failure job_id=${jobId} row_count=0`);
    }

    return {
      rowCount,
      ownershipLost: rowCount === 0,
    };
  }
}

function buildAssistantMessageAiCost(messageRow: Record<string, unknown>): Record<string, unknown> | null {
  const role = String(messageRow.role ?? '').toUpperCase();
  const messageType = String(messageRow.message_type ?? '').toUpperCase();
  const isAssistant = role === 'ASSISTANT' || messageType === 'ASSISTANT_MESSAGE';
  if (!isAssistant) {
    return null;
  }

  const metadata = (messageRow.metadata && typeof messageRow.metadata === 'object')
    ? (messageRow.metadata as Record<string, unknown>)
    : null;
  const provenanceRef = parseNullableText(messageRow.provenance_ref);
  const aiExecutionId = parseNullableText(metadata?.ai_execution_id);
  const hasJoinedAiExecution = messageRow.ai_estimated_cost !== null
    || messageRow.ai_cost_currency !== null
    || messageRow.ai_pricing_version !== null
    || messageRow.ai_provider !== null
    || messageRow.ai_model !== null;
  const hasAiLinkage = hasJoinedAiExecution
    || Boolean(aiExecutionId)
    || (provenanceRef?.startsWith('ai-execution/') ?? false)
    || (provenanceRef?.startsWith('ai-task/') ?? false);
  if (!hasAiLinkage) {
    return null;
  }

  const amount = parseNullableNumber(messageRow.ai_estimated_cost);
  const currency = parseNullableText(messageRow.ai_cost_currency);
  const pricingVersion = parseNullableText(messageRow.ai_pricing_version);
  const provider = parseNullableText(messageRow.ai_provider) ?? parseNullableText(metadata?.provider);
  const model = parseNullableText(messageRow.ai_model) ?? parseNullableText(metadata?.model);

  if (amount !== null && currency) {
    return {
      status: 'KNOWN',
      amount,
      currency,
      pricing_version: pricingVersion,
      provider,
      model,
    };
  }

  return {
    status: 'UNKNOWN',
    amount: null,
    currency: currency ?? null,
    pricing_version: pricingVersion,
    provider,
    model,
  };
}

function parseNullableText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function parseNullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

/** One sentence about the episode above the first hypo question, e.g. "Hipoglikemia około 17:08 — trwała 25 min, najniżej 62 mg/dL." */
export function buildHypoEpisodeQuestionPrefix(summary: {
  startedAtLabel: string | null;
  isOngoing: boolean;
  durationMinutes: number | null;
  minimumGlucoseMgdl: number | null;
}): string {
  const details: string[] = [];
  if (summary.isOngoing) {
    details.push('nadal trwa');
  } else if (typeof summary.durationMinutes === 'number') {
    details.push(`trwała ${summary.durationMinutes} min`);
  }
  if (typeof summary.minimumGlucoseMgdl === 'number') {
    details.push(`najniżej ${summary.minimumGlucoseMgdl} mg/dL`);
  }

  const head = summary.startedAtLabel ? `Hipoglikemia około ${summary.startedAtLabel}` : 'Hipoglikemia';
  if (!summary.startedAtLabel && details.length === 0) {
    return '';
  }

  return details.length > 0 ? `${head} — ${details.join(', ')}.` : `${head}.`;
}

export function formatIsoToLocalHourMinute(value: string, timeZone: string = resolveQuestionTimeZone()): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat('pl-PL', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

/** Caregivers read question times on the clock of the patient's home: TZ when valid, otherwise Europe/Warsaw. */
function resolveQuestionTimeZone(): string {
  return resolveHomeTimeZone();
}

function cryptoRandomUuid(): string {
  const { randomUUID } = require('crypto') as typeof import('crypto');
  return randomUUID();
}

const PHOTO_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Photo ids a caregiver message lists in its metadata (at most 3, always ids). */
export function messagePhotoIds(metadata: unknown): string[] {
  const raw = (metadata as Record<string, unknown> | null)?.photo_ids;
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string' && PHOTO_ID_PATTERN.test(id)).slice(0, 3) : [];
}
