import { caregiverDeviceSql } from './sharing-access.sql';
import { rescueAlertIssuedAt } from '@modules/rescue-carbs/application/rescue-alert-staleness';

/** Rescue carb alerts are glucose alerts: phones of members with "Glukoza i alarmy". */
const CURRENT_CAREGIVER_DEVICE_SQL = caregiverDeviceSql('glucose_alerts');
import { readOptionKey, type AnswerOptionKey } from '@modules/ai-gateway/application/answer-options';
import { createHash } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { RESCUE_ALERT_POLICY, type RescueAlertRecord, type RescueAlertStatus } from '@modules/rescue-carbs/application/rescue-alert-policy';
import { RESCUE_DETECTION_POLICY, type RescueEvaluation } from '@modules/rescue-carbs/application/rescue-detection';
import type { RescueDoseProposal } from '@modules/rescue-carbs/application/rescue-dose';
import {
  RESCUE_CARB_ENTRY_SOURCE,
  type RescueCarbProposalRecord,
  type RescueCommandLink,
  type ChatRescueProposalResult,
  type RescueCarbsStore,
  type RescueDeclineResult,
  type RescueTreatmentResult,
} from '@modules/rescue-carbs/application/rescue-carbs-store';

/** This phone's notification switches in Settings ("Ostrzeżenia o możliwym hipo", "Gotowa odpowiedź", "Zbiornik insuliny"). */
export type DeviceNotificationSettings = {
  device_id: string;
  rescue_carb_alerts_enabled: boolean;
  answer_ready_push_enabled: boolean;
  /** "Zbiornik insuliny" (migration 096, reservoir-alerts.v1); on by default. */
  reservoir_push_enabled: boolean;
};

/** Rescue carb alerts, the chat's dose cards and the carbs logged for them (migration 051, rescue-carbs.v1). */
/**
 * answer-options.v1: the key of another option of the same answer whose card was already sent to Trio (a command that
 * was not refused or lost) or whose rescue carbs were logged; null when none. The app locks the picker too, but a second
 * phone with an old view must not send a second plan.
 */
const TAKEN_OTHER_OPTION_SQL = `
  WITH me AS (
    SELECT user_message_id, option_key FROM bolus_proposals WHERE patient_id = $1::uuid AND id = $2::uuid
    UNION ALL
    SELECT user_message_id, option_key FROM rescue_carb_proposals WHERE patient_id = $1::uuid AND id = $2::uuid
  )
  SELECT b.option_key FROM bolus_proposals b JOIN me ON b.user_message_id = me.user_message_id
  WHERE me.option_key IS NOT NULL AND b.patient_id = $1::uuid AND b.option_key IS NOT NULL AND b.option_key <> me.option_key
    AND EXISTS (SELECT 1 FROM remote_commands c WHERE c.proposal_id = b.id AND c.status NOT IN ('SEND_FAILED', 'EXPIRED', 'REJECTED'))
  UNION ALL
  SELECT r.option_key FROM rescue_carb_proposals r JOIN me ON r.user_message_id = me.user_message_id
  WHERE me.option_key IS NOT NULL AND r.patient_id = $1::uuid AND r.option_key IS NOT NULL AND r.option_key <> me.option_key
    AND (r.status = 'ACCEPTED' OR r.treatment_event_id IS NOT NULL OR r.treatment_command_id IS NOT NULL)
  LIMIT 1`;

export class PostgresRescueCarbsRepository implements RescueCarbsStore, RescueCommandLink {
  constructor(private readonly pool: Pool) {}

  async listPatientsWithAlertDevices(): Promise<string[]> {
    const result = await this.pool.query<{ patient_id: string }>(
      `SELECT DISTINCT d.patient_id::text FROM patient_devices d WHERE d.platform = 'ios' AND d.active = true AND d.rescue_carb_alerts_enabled = true AND ${CURRENT_CAREGIVER_DEVICE_SQL}`,
    );
    return result.rows.map((row) => row.patient_id);
  }

  async listAlertDevices(patientId: string): Promise<Array<{ device_id: string; push_token: string }>> {
    const result = await this.pool.query<{ device_id: string; push_token: string }>(
      `
        SELECT DISTINCT ON (d.push_token) d.device_id, d.push_token
        FROM patient_devices d
        WHERE d.patient_id = $1::uuid AND d.platform = 'ios' AND d.active = true AND d.rescue_carb_alerts_enabled = true
          AND ${CURRENT_CAREGIVER_DEVICE_SQL}
        ORDER BY d.push_token, d.updated_at DESC
      `,
      [patientId],
    );
    return result.rows;
  }

  /** Only an active row: an inactive one is sent nothing, so its switches would show a lie (the app registers again on 404). */
  async getDeviceSettings(patientId: string, deviceId: string): Promise<DeviceNotificationSettings | null> {
    const result = await this.pool.query<DeviceNotificationSettings>(
      `SELECT device_id, rescue_carb_alerts_enabled, answer_ready_push_enabled, reservoir_push_enabled FROM patient_devices WHERE patient_id = $1::uuid AND platform = 'ios' AND device_id = $2 AND active = true LIMIT 1`,
      [patientId, deviceId],
    );
    return result.rows[0] ?? null;
  }

  /** Changes only the switches given; null when the device is not registered (actively) for the patient. */
  async setDeviceSettings(
    patientId: string,
    deviceId: string,
    changes: { rescue_carb_alerts_enabled?: boolean; answer_ready_push_enabled?: boolean; reservoir_push_enabled?: boolean },
  ): Promise<DeviceNotificationSettings | null> {
    const result = await this.pool.query<DeviceNotificationSettings>(
      `
        UPDATE patient_devices
        SET rescue_carb_alerts_enabled = COALESCE($3, rescue_carb_alerts_enabled),
            answer_ready_push_enabled = COALESCE($4, answer_ready_push_enabled),
            reservoir_push_enabled = COALESCE($5, reservoir_push_enabled),
            updated_at = now()
        WHERE patient_id = $1::uuid AND platform = 'ios' AND device_id = $2 AND active = true
        RETURNING device_id, rescue_carb_alerts_enabled, answer_ready_push_enabled, reservoir_push_enabled
      `,
      [patientId, deviceId, changes.rescue_carb_alerts_enabled ?? null, changes.answer_ready_push_enabled ?? null, changes.reservoir_push_enabled ?? null],
    );
    return result.rows[0] ?? null;
  }

  async getActiveAlert(patientId: string): Promise<RescueAlertRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM rescue_carb_alerts WHERE patient_id = $1::uuid AND status IN ('PENDING', 'NOTIFIED', 'TREATED') LIMIT 1`,
      [patientId],
    );
    return result.rows[0] ? toAlert(result.rows[0]) : null;
  }

  async getAlertByConversation(patientId: string, conversationId: string): Promise<RescueAlertRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM rescue_carb_alerts WHERE patient_id = $1::uuid AND conversation_id = $2::uuid LIMIT 1`,
      [patientId, conversationId],
    );
    return result.rows[0] ? toAlert(result.rows[0]) : null;
  }

  async getAlert(patientId: string, alertId: string): Promise<RescueAlertRecord | null> {
    const result = await this.pool.query(`SELECT * FROM rescue_carb_alerts WHERE patient_id = $1::uuid AND id = $2::uuid`, [patientId, alertId]);
    return result.rows[0] ? toAlert(result.rows[0]) : null;
  }

  /** Null when another active alert exists (the unique index): the caller re-reads it. */
  async insertAlert(alert: { patientId: string; status: 'PENDING' | 'NOTIFIED'; evaluation: RescueEvaluation; now: string }): Promise<RescueAlertRecord | null> {
    const result = await this.pool.query(
      `
        INSERT INTO rescue_carb_alerts (patient_id, status, level, trigger_source, first_flag_at, first_flag_reading_at, last_evaluated_at, evaluation)
        VALUES ($1::uuid, $2, $3, $4, $5::timestamptz, $6::timestamptz, $5::timestamptz, $7::jsonb)
        ON CONFLICT DO NOTHING
        RETURNING *
      `,
      [alert.patientId, alert.status, alert.evaluation.level, alert.evaluation.trigger_source, alert.now, alert.evaluation.glucose?.at ?? null, JSON.stringify(alert.evaluation)],
    );
    return result.rows[0] ? toAlert(result.rows[0]) : null;
  }

  /**
   * Every evaluation of an active alert: the "clear since" clock, and the newest evaluation while the alert is PENDING.
   * Once pushed, the stored evaluation stays the one the push (or its reminder) announced: the alert screen and the AI
   * show it as "what the push was based on", and a sensor gap afterwards must not empty it.
   */
  async touchAlert(alertId: string, args: { evaluation: RescueEvaluation; now: string; clearSince: string | null }): Promise<void> {
    await this.pool.query(
      `UPDATE rescue_carb_alerts
       SET evaluation = CASE WHEN status = 'PENDING' THEN $2::jsonb ELSE evaluation END,
           last_evaluated_at = $3::timestamptz, clear_since = $4::timestamptz, updated_at = now()
       WHERE id = $1::uuid`,
      [alertId, JSON.stringify(args.evaluation), args.now, args.clearSince],
    );
  }

  /**
   * The push goes out: the alert gets its conversation ("Dosłodzenie 14:32", origin SYSTEM) once, and the evaluation
   * and dose the push announced. The first push only from PENDING and the one reminder only from NOTIFIED without a
   * reminder yet (a worse level after a push closes the alert and starts a new one), so a concurrent treatment is never
   * undone, two workers never both push, and no reminder once the caregiver declined the carbs. Counts one send attempt
   * of that push (migration 078); markPushDelivered records that it reached a phone.
   */
  async markNotified(alertId: string, args: { patientId: string; evaluation: RescueEvaluation; proposal: RescueDoseProposal; now: string; reminder: boolean; conversationTitle: string }): Promise<RescueAlertRecord | null> {
    return this.withTransaction(async (client) => {
      const current = (await client.query(`SELECT * FROM rescue_carb_alerts WHERE id = $1::uuid FOR UPDATE`, [alertId])).rows[0];
      if (!current) return null;
      if (args.reminder ? current.status !== 'NOTIFIED' || current.reminder_sent_at || current.declined_at : current.status !== 'PENDING') return null;
      let conversationId = current.conversation_id ? String(current.conversation_id) : null;
      if (!conversationId) {
        conversationId = String((await client.query(
          `
            INSERT INTO conversations (patient_id, episode_id, origin, trigger_type, thread_state_version, awaiting_user_answer, conversation_type, title, title_source, title_updated_at)
            VALUES ($1::uuid, NULL, 'SYSTEM', 'RESCUE_CARBS', 'conv-v1', false, 'TRIGGER_INITIATED', $2, 'SYSTEM', now())
            RETURNING id
          `,
          [args.patientId, args.conversationTitle],
        )).rows[0].id);
      }
      const updated = (await client.query(
        `
          UPDATE rescue_carb_alerts
          SET status = 'NOTIFIED',
              level = $2,
              trigger_source = $3,
              evaluation = $4::jsonb,
              proposal = $5::jsonb,
              conversation_id = $6::uuid,
              notified_at = COALESCE(notified_at, $7::timestamptz),
              notified_level = $2,
              reminder_sent_at = CASE WHEN $8::boolean THEN $7::timestamptz ELSE reminder_sent_at END,
              alert_push_attempts = CASE WHEN $8::boolean THEN alert_push_attempts ELSE alert_push_attempts + 1 END,
              alert_last_push_attempt_at = CASE WHEN $8::boolean THEN alert_last_push_attempt_at ELSE $7::timestamptz END,
              reminder_push_attempts = CASE WHEN $8::boolean THEN reminder_push_attempts + 1 ELSE reminder_push_attempts END,
              reminder_last_push_attempt_at = CASE WHEN $8::boolean THEN $7::timestamptz ELSE reminder_last_push_attempt_at END,
              last_evaluated_at = $7::timestamptz,
              updated_at = now()
          WHERE id = $1::uuid
          RETURNING *
        `,
        [alertId, args.evaluation.level, args.evaluation.trigger_source, JSON.stringify(args.evaluation), JSON.stringify(args.proposal), conversationId, args.now, args.reminder],
      )).rows[0];
      return toAlert(updated);
    });
  }

  /**
   * One more try of a push that reached no phone: only while the alert is NOTIFIED, not declined or treated, the push
   * still undelivered and its last try at least 45 s old (a second worker gets null).
   */
  async claimPushResend(alertId: string, args: { reminder: boolean; now: string }): Promise<RescueAlertRecord | null> {
    const column = args.reminder ? 'reminder' : 'alert';
    const result = await this.pool.query(
      `
        UPDATE rescue_carb_alerts
        SET ${column}_push_attempts = ${column}_push_attempts + 1, ${column}_last_push_attempt_at = $2::timestamptz, updated_at = now()
        WHERE id = $1::uuid AND status = 'NOTIFIED' AND declined_at IS NULL
          AND treatment_event_id IS NULL AND treatment_command_id IS NULL
          AND ${args.reminder ? 'reminder_sent_at IS NOT NULL' : 'notified_at IS NOT NULL'}
          AND ${column}_delivered_at IS NULL
          AND (${column}_last_push_attempt_at IS NULL OR ${column}_last_push_attempt_at <= $2::timestamptz - make_interval(secs => $3))
        RETURNING *
      `,
      [alertId, args.now, RESCUE_ALERT_POLICY.resend_every_seconds],
    );
    return result.rows[0] ? toAlert(result.rows[0]) : null;
  }

  async markPushDelivered(alertId: string, args: { reminder: boolean; now: string }): Promise<void> {
    const column = args.reminder ? 'reminder_delivered_at' : 'alert_delivered_at';
    await this.pool.query(
      `UPDATE rescue_carb_alerts SET ${column} = COALESCE(${column}, $2::timestamptz), updated_at = now() WHERE id = $1::uuid`,
      [alertId, args.now],
    );
  }

  async closeAlert(alertId: string, args: { status: Extract<RescueAlertStatus, 'RESOLVED' | 'EXPIRED' | 'CANCELLED'>; outcome: unknown | null; now: string }): Promise<void> {
    await this.pool.query(
      `
        UPDATE rescue_carb_alerts
        SET status = $2, outcome = $3::jsonb, resolved_at = $4::timestamptz, updated_at = now()
        WHERE id = $1::uuid AND status IN ('PENDING', 'NOTIFIED', 'TREATED')
      `,
      [alertId, args.status, args.outcome === null ? null : JSON.stringify(args.outcome), args.now],
    );
  }

  /** Newest carb entry in [from, to] that was eaten (correction carbs, WBT units and deleted entries do not count). */
  async getLastEatenCarbsAt(patientId: string, fromIso: string, toIso: string): Promise<string | null> {
    const result = await this.pool.query<{ occurred_at: Date }>(
      `
        SELECT e.occurred_at
        FROM events e
        LEFT JOIN carb_entry_kinds k ON k.patient_id = e.patient_id AND k.event_id = e.id
        WHERE e.patient_id = $1::uuid
          AND e.type = 'CARB_ENTRY'
          AND e.occurred_at >= $2::timestamptz AND e.occurred_at <= $3::timestamptz
          AND COALESCE(k.kind, 'MEAL') IN ('MEAL', 'HYPO_TREATMENT')
          AND CASE WHEN e.payload->>'carbs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (e.payload->>'carbs')::numeric > 0 ELSE false END
        ORDER BY e.occurred_at DESC
        LIMIT 1
      `,
      [patientId, fromIso, toIso],
    );
    return result.rows[0] ? new Date(result.rows[0].occurred_at).toISOString() : null;
  }

  /**
   * Newest eaten carbs in [from, to] (as getLastEatenCarbsAt) and the newest rescue carbs among them: the kind
   * HYPO_TREATMENT, a Trio entry that is an alert's or a chat card's treatment (rescue carbs sent to Trio), or an entry
   * nobody gave a kind that was eaten while glucose was below 70 (audit 2026-10-26: carbs typed into Trio during a low
   * are a rescue, so the alert does not ask for a second one).
   */
  async getRecentEatenCarbs(patientId: string, fromIso: string, toIso: string): Promise<{ last_carbs_at: string | null; last_hypo_treatment_at: string | null }> {
    const result = await this.pool.query<{ last_carbs_at: Date | null; last_hypo_treatment_at: Date | null }>(
      `
        SELECT max(e.occurred_at) AS last_carbs_at,
               max(e.occurred_at) FILTER (
                 WHERE k.kind = 'HYPO_TREATMENT'
                   OR EXISTS (SELECT 1 FROM rescue_carb_alerts a WHERE a.patient_id = e.patient_id AND a.treatment_event_id = e.id)
                   OR EXISTS (SELECT 1 FROM rescue_carb_proposals p WHERE p.patient_id = e.patient_id AND p.treatment_event_id = e.id)
                   OR (k.kind IS NULL AND (
                     SELECT CASE WHEN g.payload->>'glucose_value' ~ '^[0-9]+(\.[0-9]+)?$' THEN (g.payload->>'glucose_value')::numeric END
                     FROM events g
                     WHERE g.patient_id = e.patient_id AND g.type = 'GLUCOSE_READING_AVAILABLE'
                       AND g.occurred_at <= e.occurred_at + interval '2 minutes' AND g.occurred_at >= e.occurred_at - interval '15 minutes'
                     ORDER BY g.occurred_at DESC
                     LIMIT 1
                   ) < $4)
               ) AS last_hypo_treatment_at
        FROM events e
        LEFT JOIN carb_entry_kinds k ON k.patient_id = e.patient_id AND k.event_id = e.id
        WHERE e.patient_id = $1::uuid
          AND e.type = 'CARB_ENTRY'
          AND e.occurred_at >= $2::timestamptz AND e.occurred_at <= $3::timestamptz
          AND COALESCE(k.kind, 'MEAL') IN ('MEAL', 'HYPO_TREATMENT')
          AND CASE WHEN e.payload->>'carbs' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (e.payload->>'carbs')::numeric > 0 ELSE false END
      `,
      [patientId, fromIso, toIso, RESCUE_DETECTION_POLICY.low_mgdl],
    );
    const row = result.rows[0];
    return {
      last_carbs_at: row?.last_carbs_at ? new Date(row.last_carbs_at).toISOString() : null,
      last_hypo_treatment_at: row?.last_hypo_treatment_at ? new Date(row.last_hypo_treatment_at).toISOString() : null,
    };
  }

  /**
   * "Podano dosłodzenie": a carb entry of GlucoMind's own (never sent to Nightscout or the loop) with the kind
   * HYPO_TREATMENT, and the alert TREATED. One treatment per alert: a second caregiver gets ALREADY_LOGGED.
   */
  async logTreatment(args: { patientId: string; alertId: string; carbsG: number; givenAt: string; userId: string | null; source: 'ALERT' | 'CHAT_CARD'; proposalId: string | null }): Promise<RescueTreatmentResult> {
    return this.withTransaction(async (client) => {
      const alert = (await client.query(`SELECT * FROM rescue_carb_alerts WHERE patient_id = $1::uuid AND id = $2::uuid FOR UPDATE`, [args.patientId, args.alertId])).rows[0];
      if (!alert) return { status: 'NOT_FOUND' as const };
      if (alert.treatment_event_id || alert.treatment_command_id) {
        const name = alert.treated_by_user_id ? await this.displayName(client, String(alert.treated_by_user_id)) : null;
        return { status: 'ALREADY_LOGGED' as const, logged_by: name };
      }
      if (args.proposalId) {
        const proposal = (await client.query(
          `SELECT id FROM rescue_carb_proposals WHERE patient_id = $1::uuid AND id = $2::uuid AND alert_id = $3::uuid AND status = 'PROPOSED'`,
          [args.patientId, args.proposalId, args.alertId],
        )).rows[0];
        if (!proposal) return { status: 'PROPOSAL_NOT_FOUND' as const };
      }

      const eventId = await this.insertCarbEntry(client, {
        patientId: args.patientId,
        naturalKey: `rescue-carbs:${args.alertId}`,
        carbsG: args.carbsG,
        givenAt: args.givenAt,
        userId: args.userId,
        raw: { rescue_alert_id: args.alertId, source: args.source, proposal_id: args.proposalId },
        payload: { rescue_alert_id: args.alertId },
      });
      if (args.proposalId) {
        await client.query(`UPDATE rescue_carb_proposals SET status = 'ACCEPTED', updated_at = now() WHERE id = $1::uuid`, [args.proposalId]);
      }
      const updated = (await client.query(
        `
          UPDATE rescue_carb_alerts
          SET status = CASE WHEN status IN ('PENDING', 'NOTIFIED', 'TREATED') THEN 'TREATED' ELSE status END,
              treatment_event_id = $2::uuid,
              treatment_carbs_g = $3,
              treated_at = $4::timestamptz,
              treated_by_user_id = $5::uuid,
              treatment_source = $6,
              treatment_proposal_id = $7::uuid,
              updated_at = now()
          WHERE id = $1::uuid
          RETURNING *
        `,
        [args.alertId, eventId, args.carbsG, args.givenAt, args.userId, args.source, args.proposalId],
      )).rows[0];
      return { status: 'LOGGED' as const, alert: toAlert(updated), event_id: eventId };
    });
  }

  /**
   * "Zatwierdź Y g" on a card of an ordinary conversation (no alert): logged in GlucoMind (an open alert that pushed
   * takes them), and the card keeps what was logged. One confirmation per card: the other caregiver gets
   * ALREADY_LOGGED.
   */
  async acceptChatProposal(args: { patientId: string; conversationId: string; proposalId: string; carbsG: number; givenAt: string; userId: string | null }): Promise<ChatRescueProposalResult> {
    return this.withTransaction(async (client) => {
      const proposal = (await client.query(
        `SELECT * FROM rescue_carb_proposals WHERE patient_id = $1::uuid AND id = $2::uuid AND conversation_id = $3::uuid AND alert_id IS NULL AND status <> 'DISCARDED' FOR UPDATE`,
        [args.patientId, args.proposalId, args.conversationId],
      )).rows[0];
      if (!proposal) return { status: 'PROPOSAL_NOT_FOUND' as const };
      const taken = (await client.query(TAKEN_OTHER_OPTION_SQL, [args.patientId, args.proposalId])).rows[0];
      if (taken) return { status: 'OPTION_TAKEN' as const, option: String(taken.option_key) };
      if (proposal.status === 'ACCEPTED') {
        const name = proposal.treated_by_user_id ? await this.displayName(client, String(proposal.treated_by_user_id)) : null;
        return { status: 'ALREADY_LOGGED' as const, logged_by: name };
      }
      const logged = await this.logChatCardInTransaction(client, { patientId: args.patientId, carbsG: args.carbsG, givenAt: args.givenAt, userId: args.userId, proposalId: args.proposalId });
      const updated = (await client.query(
        `
          UPDATE rescue_carb_proposals
          SET status = 'ACCEPTED', treatment_event_id = $2::uuid, treatment_carbs_g = $3, treated_at = $4::timestamptz,
              treated_by_user_id = $5::uuid, updated_at = now()
          WHERE id = $1::uuid
          RETURNING *
        `,
        [args.proposalId, logged.event_id, args.carbsG, args.givenAt, args.userId],
      )).rows[0];
      return { status: 'LOGGED' as const, proposal: toProposal(updated), alert_id: logged.alert_id };
    });
  }

  /**
   * Rescue carbs from a card of an ordinary conversation (no alert's card), stored like the alert's (GlucoMind only,
   * HYPO_TREATMENT). An open alert that already pushed and has no treatment yet takes them when they were given after it
   * started (15 min of slack), so its reminder is not sent; a PENDING one is cancelled by the recent carbs.
   */
  private async logChatCardInTransaction(
    client: PoolClient,
    args: { patientId: string; carbsG: number; givenAt: string; userId: string | null; proposalId: string },
  ): Promise<{ event_id: string; alert_id: string | null }> {
    const alert = (await client.query(
      `
        SELECT id FROM rescue_carb_alerts
        WHERE patient_id = $1::uuid AND status = 'NOTIFIED' AND treatment_event_id IS NULL AND treatment_command_id IS NULL
          AND $2::timestamptz >= first_flag_at - interval '15 minutes'
        LIMIT 1
        FOR UPDATE
      `,
      [args.patientId, args.givenAt],
    )).rows[0] as { id: string } | undefined;
    const alertId = alert ? String(alert.id) : null;
    const eventId = await this.insertCarbEntry(client, {
      patientId: args.patientId,
      naturalKey: `rescue-carbs:card:${args.proposalId}`,
      carbsG: args.carbsG,
      givenAt: args.givenAt,
      userId: args.userId,
      raw: { rescue_alert_id: alertId, source: 'CHAT_CARD', proposal_id: args.proposalId },
      payload: alertId ? { rescue_alert_id: alertId } : {},
    });
    if (alertId) {
      // The alert says where its carbs came from: a card of an ordinary conversation (CHAT_CARD).
      await client.query(
        `
          UPDATE rescue_carb_alerts
          SET status = 'TREATED', treatment_event_id = $2::uuid, treatment_carbs_g = $3, treated_at = $4::timestamptz,
              treated_by_user_id = $5::uuid, treatment_source = $6, treatment_proposal_id = $7::uuid, updated_at = now()
          WHERE id = $1::uuid
        `,
        [alertId, eventId, args.carbsG, args.givenAt, args.userId, 'CHAT_CARD', args.proposalId],
      );
    }
    return { event_id: eventId, alert_id: alertId };
  }

  /** A GlucoMind carb entry (never in Nightscout or the loop) with the kind HYPO_TREATMENT; returns its event id. */
  private async insertCarbEntry(
    client: PoolClient,
    args: { patientId: string; naturalKey: string; carbsG: number; givenAt: string; userId: string | null; raw: Record<string, unknown>; payload: Record<string, unknown> },
  ): Promise<string> {
    const source = (await client.query(
      `
        INSERT INTO sources (patient_id, source_system, source_key, source_version, metadata)
        VALUES ($1::uuid, $2, 'rescue-carbs', 'rescue-carbs.v1', '{}'::jsonb)
        ON CONFLICT (patient_id, source_system, source_key) DO UPDATE SET updated_at = now()
        RETURNING id
      `,
      [args.patientId, RESCUE_CARB_ENTRY_SOURCE],
    )).rows[0];
    const rawPayload = { carbs: args.carbsG, given_at: args.givenAt, logged_by_user_id: args.userId, ...args.raw };
    const naturalKey = args.naturalKey;
    const record = (await client.query(
      `
        INSERT INTO source_records (
          patient_id, source_id, source_system, source_record_id, natural_key, record_type, occurred_at, recorded_at, imported_at,
          payload_version, normalization_version, validity, raw_payload, provenance, canonical_hash
        ) VALUES ($1::uuid, $2::uuid, $3, $4, $4, 'RESCUE_CARBS', $5::timestamptz, now(), now(), 1, 'rescue-carbs.v1', 'VALID', $6::jsonb, $7::jsonb, $8)
        RETURNING id
      `,
      [
        args.patientId,
        source.id,
        RESCUE_CARB_ENTRY_SOURCE,
        naturalKey,
        args.givenAt,
        JSON.stringify(rawPayload),
        JSON.stringify({ logged_in: 'GLUCOMIND', in_nightscout: false }),
        createHash('sha256').update(`${args.patientId}:${naturalKey}`).digest('hex'),
      ],
    )).rows[0];
    const event = (await client.query(
      `
        INSERT INTO events (patient_id, source_record_id, type, occurred_at, recorded_at, source, context, payload, event_version, event_ingestion_origin)
        VALUES ($1::uuid, $2::uuid, 'CARB_ENTRY', $3::timestamptz, now(), $4::jsonb, '{}'::jsonb, $5::jsonb, 1, 'LIVE')
        RETURNING id::text
      `,
      [
        args.patientId,
        record.id,
        args.givenAt,
        JSON.stringify({ source_system: RESCUE_CARB_ENTRY_SOURCE, source_record_id: naturalKey }),
        // The loop never got these carbs: its COB, IOB and forecasts do not include them.
        JSON.stringify({ carbs: args.carbsG, entry_source: RESCUE_CARB_ENTRY_SOURCE, in_loop: false, ...args.payload }),
      ],
    )).rows[0];
    await client.query(
      `INSERT INTO carb_entry_kinds (patient_id, event_id, kind, set_by_user_id, set_at) VALUES ($1::uuid, $2::uuid, 'HYPO_TREATMENT', $3::uuid, now())`,
      [args.patientId, event.id, args.userId],
    );
    return String(event.id);
  }

  /** Rescue carbs to Trio: whether the alert or card can still take a treatment (before the command is stored). */
  async checkAvailable(args: { patientId: string; alertId: string | null; proposalId: string | null }): Promise<{ status: 'OK'; alert_id: string | null; issued_at: string | null } | { status: 'ALREADY_LOGGED'; logged_by: string | null } | { status: 'NOT_FOUND' }> {
    const client = await this.pool.connect();
    try {
      let alertId = args.alertId;
      let issuedAt: string | null = null;
      if (args.proposalId) {
        const proposal = (await client.query(`SELECT * FROM rescue_carb_proposals WHERE patient_id = $1::uuid AND id = $2::uuid AND status <> 'DISCARDED'`, [args.patientId, args.proposalId])).rows[0];
        if (!proposal) return { status: 'NOT_FOUND' };
        if (proposal.status === 'ACCEPTED' || proposal.treatment_command_id) {
          return { status: 'ALREADY_LOGGED', logged_by: proposal.treated_by_user_id ? await this.displayName(client, String(proposal.treated_by_user_id)) : null };
        }
        alertId = alertId ?? (proposal.alert_id ? String(proposal.alert_id) : null);
        issuedAt = iso(proposal.created_at);
      }
      if (alertId) {
        const alert = (await client.query(`SELECT * FROM rescue_carb_alerts WHERE patient_id = $1::uuid AND id = $2::uuid`, [args.patientId, alertId])).rows[0];
        if (!alert) return { status: 'NOT_FOUND' };
        if (alert.treatment_event_id || alert.treatment_command_id) {
          return { status: 'ALREADY_LOGGED', logged_by: alert.treated_by_user_id ? await this.displayName(client, String(alert.treated_by_user_id)) : null };
        }
        // A card counts from when it was proposed; the alert itself from its last push.
        issuedAt = issuedAt ?? rescueAlertIssuedAt({ reminder_sent_at: iso(alert.reminder_sent_at), notified_at: iso(alert.notified_at), first_flag_at: iso(alert.first_flag_at) });
      }
      return { status: 'OK', alert_id: alertId, issued_at: issuedAt };
    } finally {
      client.release();
    }
  }

  /**
   * Rescue carbs to Trio, once the command is stored: the card (if any) is ACCEPTED by it, and the alert (the given one,
   * the card's, or the open one that already pushed) is TREATED by it, so no reminder follows and nobody logs it twice.
   * Nothing is written as a GlucoMind carb entry: the Trio entry is the one record (linkCommandEntry).
   */
  async takenOtherOption(patientId: string, proposalId: string): Promise<string | null> {
    if (!/^[0-9a-f-]{36}$/i.test(proposalId)) return null;
    const row = (await this.pool.query(TAKEN_OTHER_OPTION_SQL, [patientId, proposalId])).rows[0];
    return row ? String(row.option_key) : null;
  }

  async reserveForCommand(args: { patientId: string; commandId: string; alertId: string | null; proposalId: string | null; carbsG: number; atIso: string; userId: string }): Promise<{ alert_id: string | null; reserved: boolean }> {
    return this.withTransaction(async (client) => {
      let alertId = args.alertId;
      if (args.proposalId) {
        const proposal = (await client.query(
          `UPDATE rescue_carb_proposals SET status = 'ACCEPTED', treatment_command_id = $3::uuid, treatment_carbs_g = $4, treated_at = $5::timestamptz,
                  treated_by_user_id = $6::uuid, updated_at = now()
           WHERE patient_id = $1::uuid AND id = $2::uuid AND status = 'PROPOSED' AND treatment_command_id IS NULL
           RETURNING alert_id`,
          [args.patientId, args.proposalId, args.commandId, args.carbsG, args.atIso, args.userId],
        )).rows[0];
        // The card was confirmed meanwhile (the other caregiver, or "Nie wysyłaj do Trio"): this command must not go.
        if (!proposal) return { alert_id: null, reserved: false };
        if (proposal.alert_id) alertId = alertId ?? String(proposal.alert_id);
      }
      if (!alertId) {
        const open = (await client.query(
          `SELECT id FROM rescue_carb_alerts
           WHERE patient_id = $1::uuid AND status = 'NOTIFIED' AND treatment_event_id IS NULL AND treatment_command_id IS NULL
             AND $2::timestamptz >= first_flag_at - interval '15 minutes'
           LIMIT 1 FOR UPDATE`,
          [args.patientId, args.atIso],
        )).rows[0];
        alertId = open ? String(open.id) : null;
      }
      if (!alertId) return { alert_id: null, reserved: true };
      const source = args.proposalId ? 'CHAT_CARD' : args.alertId ? 'ALERT' : 'MANUAL';
      const updated = (await client.query(
        `UPDATE rescue_carb_alerts
         SET status = CASE WHEN status IN ('PENDING', 'NOTIFIED', 'TREATED') THEN 'TREATED' ELSE status END,
             treatment_command_id = $3::uuid, treatment_carbs_g = $4, treated_at = $5::timestamptz, treated_by_user_id = $6::uuid,
             treatment_source = $7, treatment_proposal_id = $8::uuid, updated_at = now()
         WHERE patient_id = $1::uuid AND id = $2::uuid AND treatment_event_id IS NULL AND treatment_command_id IS NULL
         RETURNING id`,
        [args.patientId, alertId, args.commandId, args.carbsG, args.atIso, args.userId, source, args.proposalId],
      )).rows[0];
      // A named alert treated meanwhile refuses the command; the open alert found here only joins when it can.
      return { alert_id: updated ? String(updated.id) : null, reserved: updated !== undefined || args.alertId === null };
    });
  }

  /** The Trio entry of a rescue command came back through Nightscout: it is the alert's and card's treatment. */
  async linkCommandEntry(patientId: string, commandId: string, carbEventId: string): Promise<void> {
    await this.pool.query(
      `UPDATE rescue_carb_alerts SET treatment_event_id = $3::uuid, updated_at = now()
       WHERE patient_id = $1::uuid AND treatment_command_id = $2::uuid AND treatment_event_id IS NULL`,
      [patientId, commandId, carbEventId],
    );
    await this.pool.query(
      `UPDATE rescue_carb_proposals SET treatment_event_id = $3::uuid, updated_at = now()
       WHERE patient_id = $1::uuid AND treatment_command_id = $2::uuid AND treatment_event_id IS NULL`,
      [patientId, commandId, carbEventId],
    );
  }

  /**
   * A rescue command Trio refused, that never left the phone or expired unsent gives its treatment back: the alert is
   * open again (it may remind) and the card can be confirmed again. Never after the Trio entry arrived.
   */
  async releaseFailedCommandTreatments(): Promise<number> {
    // Refused or never sent; or no answer from Trio and no carb entry of it in Nightscout after 3 h (the push most likely
    // never arrived): the alert must be able to remind again and the carbs to be logged.
    const failed = `SELECT id FROM remote_commands WHERE purpose = 'HYPO_TREATMENT' AND (status IN ('REJECTED', 'SEND_FAILED', 'EXPIRED')
      OR (status = 'NO_REPLY' AND loop_action_id IS NULL AND authorized_at < now() - interval '3 hours'))`;
    const alerts = await this.pool.query(
      `UPDATE rescue_carb_alerts
       SET status = CASE WHEN status = 'TREATED' THEN 'NOTIFIED' ELSE status END, treatment_command_id = NULL, treatment_carbs_g = NULL,
           treated_at = NULL, treated_by_user_id = NULL, treatment_source = NULL, treatment_proposal_id = NULL, updated_at = now()
       WHERE treatment_event_id IS NULL AND status = 'TREATED' AND treatment_command_id IN (${failed})`,
    );
    // A closed alert keeps its history (its outcome counted the treatment); its card is not offered again either.
    const proposals = await this.pool.query(
      `UPDATE rescue_carb_proposals p
       SET status = 'PROPOSED', treatment_command_id = NULL, treatment_carbs_g = NULL, treated_at = NULL, treated_by_user_id = NULL, updated_at = now()
       WHERE p.treatment_event_id IS NULL AND p.treatment_command_id IN (${failed})
         AND (p.alert_id IS NULL OR EXISTS (
           SELECT 1 FROM rescue_carb_alerts a WHERE a.id = p.alert_id AND a.status IN ('PENDING', 'NOTIFIED', 'TREATED')
         ))`,
    );
    return (alerts.rowCount ?? 0) + (proposals.rowCount ?? 0);
  }

  /**
   * "Nie podaję": the caregiver decided not to give rescue carbs for this alert. The alert stays open (the worker sends
   * no reminder and closes it as usual); carbs logged later still turn it TREATED.
   */
  async declineAlert(args: { patientId: string; alertId: string; userId: string | null }): Promise<RescueDeclineResult> {
    return this.withTransaction(async (client) => {
      const alert = (await client.query(`SELECT * FROM rescue_carb_alerts WHERE patient_id = $1::uuid AND id = $2::uuid FOR UPDATE`, [args.patientId, args.alertId])).rows[0];
      if (!alert) return { status: 'NOT_FOUND' as const };
      if (alert.treatment_event_id || alert.treatment_command_id) {
        const name = alert.treated_by_user_id ? await this.displayName(client, String(alert.treated_by_user_id)) : null;
        return { status: 'ALREADY_LOGGED' as const, logged_by: name };
      }
      if (alert.declined_at) return { status: 'DECLINED' as const, alert: toAlert(alert) };
      const updated = (await client.query(
        `UPDATE rescue_carb_alerts SET declined_at = now(), declined_by_user_id = $2::uuid, updated_at = now() WHERE id = $1::uuid RETURNING *`,
        [args.alertId, args.userId],
      )).rows[0];
      return { status: 'DECLINED' as const, alert: toAlert(updated) };
    });
  }

  async userDisplayName(userId: string): Promise<string | null> {
    const client = await this.pool.connect();
    try {
      return await this.displayName(client, userId);
    } finally {
      client.release();
    }
  }

  async insertProposal(proposal: { patientId: string; alertId: string | null; conversationId: string; userMessageId: string; carbsG: number; reason: string | null; optionKey: AnswerOptionKey | null }): Promise<RescueCarbProposalRecord> {
    const result = await this.pool.query(
      `
        INSERT INTO rescue_carb_proposals (patient_id, alert_id, conversation_id, user_message_id, carbs_g, reason, option_key)
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7)
        RETURNING *
      `,
      [proposal.patientId, proposal.alertId, proposal.conversationId, proposal.userMessageId, proposal.carbsG, proposal.reason, proposal.optionKey],
    );
    return toProposal(result.rows[0]);
  }

  /** A card of an answer in progress that a newer card for the same option replaces (never shown). */
  async discardProposal(patientId: string, proposalId: string): Promise<void> {
    await this.pool.query(
      `UPDATE rescue_carb_proposals SET status = 'DISCARDED', updated_at = now() WHERE patient_id = $1::uuid AND id = $2::uuid AND status = 'PROPOSED'`,
      [patientId, proposalId],
    );
  }

  /** Cards a failed earlier attempt prepared for the same caregiver message (never shown). */
  async discardProposalsForUserMessage(patientId: string, userMessageId: string): Promise<void> {
    await this.pool.query(
      `UPDATE rescue_carb_proposals SET status = 'DISCARDED', updated_at = now() WHERE patient_id = $1::uuid AND user_message_id = $2::uuid AND status = 'PROPOSED'`,
      [patientId, userMessageId],
    );
  }

  /** The cards one answer prepared (not discarded), for a stored result reused on a retry. */
  async listProposalsForUserMessage(patientId: string, userMessageId: string): Promise<RescueCarbProposalRecord[]> {
    const rows = (await this.pool.query(
      `SELECT * FROM rescue_carb_proposals WHERE patient_id = $1::uuid AND user_message_id = $2::uuid AND status <> 'DISCARDED' ORDER BY created_at`,
      [patientId, userMessageId],
    )).rows;
    return rows.map(toProposal);
  }

  async listProposalsForConversation(patientId: string, conversationId: string): Promise<RescueCarbProposalRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM rescue_carb_proposals WHERE patient_id = $1::uuid AND conversation_id = $2::uuid AND status <> 'DISCARDED' ORDER BY created_at`,
      [patientId, conversationId],
    );
    return result.rows.map(toProposal);
  }

  private async displayName(client: PoolClient, userId: string): Promise<string | null> {
    const row = (await client.query<{ display_name: string | null }>(`SELECT display_name FROM users WHERE id = $1::uuid`, [userId])).rows[0];
    const name = row?.display_name?.trim() ?? '';
    // Cognito subjects stored as names are not names.
    return name && !/^(cognito:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name) ? name : null;
  }

  private async withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

const iso = (value: unknown): string | null => (value === null || value === undefined ? null : new Date(value as string).toISOString());

function toAlert(row: Record<string, unknown>): RescueAlertRecord {
  return {
    id: String(row.id),
    patient_id: String(row.patient_id),
    status: row.status as RescueAlertRecord['status'],
    level: row.level as RescueAlertRecord['level'],
    trigger_source: row.trigger_source as RescueAlertRecord['trigger_source'],
    first_flag_at: iso(row.first_flag_at)!,
    first_flag_reading_at: iso(row.first_flag_reading_at),
    notified_at: iso(row.notified_at),
    notified_level: (row.notified_level ?? null) as RescueAlertRecord['notified_level'],
    reminder_sent_at: iso(row.reminder_sent_at),
    alert_push_attempts: Number(row.alert_push_attempts ?? 0),
    alert_last_push_attempt_at: iso(row.alert_last_push_attempt_at),
    alert_delivered_at: iso(row.alert_delivered_at),
    reminder_push_attempts: Number(row.reminder_push_attempts ?? 0),
    reminder_last_push_attempt_at: iso(row.reminder_last_push_attempt_at),
    reminder_delivered_at: iso(row.reminder_delivered_at),
    last_evaluated_at: iso(row.last_evaluated_at)!,
    clear_since: iso(row.clear_since),
    evaluation: row.evaluation as RescueEvaluation,
    proposal: (row.proposal ?? null) as RescueDoseProposal | null,
    conversation_id: row.conversation_id ? String(row.conversation_id) : null,
    treatment_event_id: row.treatment_event_id ? String(row.treatment_event_id) : null,
    treatment_carbs_g: row.treatment_carbs_g === null || row.treatment_carbs_g === undefined ? null : Number(row.treatment_carbs_g),
    treated_at: iso(row.treated_at),
    treated_by_user_id: row.treated_by_user_id ? String(row.treated_by_user_id) : null,
    treatment_source: (row.treatment_source ?? null) as RescueAlertRecord['treatment_source'],
    treatment_proposal_id: row.treatment_proposal_id ? String(row.treatment_proposal_id) : null,
    treatment_command_id: row.treatment_command_id ? String(row.treatment_command_id) : null,
    declined_at: iso(row.declined_at),
    declined_by_user_id: row.declined_by_user_id ? String(row.declined_by_user_id) : null,
    outcome: (row.outcome ?? null) as RescueAlertRecord['outcome'],
    resolved_at: iso(row.resolved_at),
    created_at: iso(row.created_at)!,
  };
}

function toProposal(row: Record<string, unknown>): RescueCarbProposalRecord {
  return {
    id: String(row.id),
    patient_id: String(row.patient_id),
    alert_id: row.alert_id ? String(row.alert_id) : null,
    conversation_id: String(row.conversation_id),
    user_message_id: String(row.user_message_id),
    carbs_g: Number(row.carbs_g),
    reason: row.reason ? String(row.reason) : null,
    option_key: readOptionKey(row.option_key),
    status: row.status as RescueCarbProposalRecord['status'],
    created_at: iso(row.created_at)!,
    treatment: row.treatment_event_id || row.treatment_command_id
      ? {
        event_id: row.treatment_event_id ? String(row.treatment_event_id) : null,
        carbs_g: Number(row.treatment_carbs_g),
        given_at: iso(row.treated_at)!,
        logged_by_user_id: row.treated_by_user_id ? String(row.treated_by_user_id) : null,
        in_loop: row.treatment_command_id !== null && row.treatment_command_id !== undefined,
        command_id: row.treatment_command_id ? String(row.treatment_command_id) : null,
      }
      : null,
  };
}
