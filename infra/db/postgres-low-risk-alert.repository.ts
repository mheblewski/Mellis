import type { Pool } from 'pg';
import { isLowRiskRescueSource, lowRiskVerdictOf, type LowRiskScoreEntry, type LowRiskStore } from '@modules/glucose-forecast/application/low-risk-alert.service';
import type { LowRiskVerdict } from '@modules/rescue-carbs/application/rescue-detection';
import { LOW_RISK_MODEL_ID, type LowRiskParams } from '@modules/glucose-forecast/application/low-risk';
import type { LowComparison, LowComparisonRow } from '@modules/glucose-forecast/application/low-risk-comparison';
import { caregiverDeviceSql } from './sharing-access.sql';

/**
 * The low-warning model's data. Every patient with the prediction experiment on is scored in the background; the model
 * decides the predicted-low alert, and its own test push goes out, only for patients with someone listed in
 * prediction_low_alert_recipients (rows added by hand, after the comparison was read).
 */
export class PostgresLowRiskAlertRepository implements LowRiskStore {
  constructor(private readonly pool: Pool) {}

  async listPatients(): Promise<string[]> {
    const result = await this.pool.query<{ patient_id: string }>(`SELECT patient_id::text FROM prediction_experiment_optins WHERE enabled`);
    return result.rows.map((row) => row.patient_id);
  }

  /** Someone is listed for the patient: the model may decide the predicted-low alert there. */
  async decidesAlert(patientId: string): Promise<boolean> {
    const result = await this.pool.query(`SELECT 1 FROM prediction_low_alert_recipients WHERE patient_id = $1::uuid LIMIT 1`, [patientId]);
    return (result.rowCount ?? 0) > 0;
  }

  /** One per push token: a phone registered twice gets the push once. */
  async listPushTokens(patientId: string): Promise<string[]> {
    const result = await this.pool.query<{ push_token: string }>(
      `SELECT DISTINCT d.push_token
         FROM patient_devices d
         JOIN prediction_low_alert_recipients listed ON listed.patient_id = d.patient_id AND listed.user_id = d.user_id
        WHERE d.patient_id = $1::uuid AND d.platform = 'ios' AND d.active = true AND ${caregiverDeviceSql('glucose_alerts')}`,
      [patientId],
    );
    return result.rows.map((row) => row.push_token);
  }

  async getParams(patientId: string): Promise<{ params: LowRiskParams; stored_at: string } | null> {
    const result = await this.pool.query<{ params: LowRiskParams; fitted_at: Date }>(
      `SELECT params, fitted_at FROM prediction_params WHERE patient_id = $1::uuid AND model_id = $2`,
      [patientId, LOW_RISK_MODEL_ID],
    );
    const row = result.rows[0];
    return row ? { params: row.params, stored_at: new Date(row.fitted_at).toISOString() } : null;
  }

  async saveParams(patientId: string, params: LowRiskParams, now: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO prediction_params (patient_id, model_id, params, fitted_at) VALUES ($1::uuid, $2, $3::jsonb, $4)
       ON CONFLICT (patient_id, model_id) DO UPDATE SET params = EXCLUDED.params, fitted_at = EXCLUDED.fitted_at`,
      [patientId, params.model_id, JSON.stringify(params), now.toISOString()],
    );
  }

  private async newest(patientId: string, onlyAlarms: boolean): Promise<string | null> {
    const result = await this.pool.query<{ at: Date | null }>(
      `SELECT max(reading_at) AS at FROM prediction_low_scores WHERE patient_id = $1::uuid AND model_id = $2 AND ($3::boolean = false OR alarm)`,
      [patientId, LOW_RISK_MODEL_ID, onlyAlarms],
    );
    const at = result.rows[0]?.at;
    return at ? new Date(at).toISOString() : null;
  }

  async latestScore(patientId: string): Promise<{ reading_at: string; score: number; threshold: number; alarm: boolean } | null> {
    const result = await this.pool.query<{ reading_at: Date; score: number; threshold: number; alarm: boolean }>(
      `SELECT reading_at, score, threshold, alarm FROM prediction_low_scores
        WHERE patient_id = $1::uuid AND model_id = $2 ORDER BY reading_at DESC LIMIT 1`,
      [patientId, LOW_RISK_MODEL_ID],
    );
    const row = result.rows[0];
    return row ? { reading_at: new Date(row.reading_at).toISOString(), score: Number(row.score), threshold: Number(row.threshold), alarm: row.alarm } : null;
  }

  lastScoredAt(patientId: string): Promise<string | null> {
    return this.newest(patientId, false);
  }

  lastAlarmAt(patientId: string): Promise<string | null> {
    return this.newest(patientId, true);
  }

  async logScore(entry: LowRiskScoreEntry): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO prediction_low_scores (patient_id, reading_at, model_id, glucose_mgdl, score, threshold, alarm)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7) ON CONFLICT (patient_id, reading_at, model_id) DO NOTHING`,
      [entry.patient_id, entry.reading_at, entry.model_id, entry.glucose_mgdl, entry.score, entry.threshold, entry.alarm],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markPushed(entry: LowRiskScoreEntry, pushedTo: number): Promise<void> {
    await this.pool.query(
      `UPDATE prediction_low_scores SET pushed_to = $4 WHERE patient_id = $1::uuid AND reading_at = $2 AND model_id = $3`,
      [entry.patient_id, entry.reading_at, entry.model_id, pushedTo],
    );
  }

  /** When a low alert reached a phone: the rescue alert's pushes and the model's own experimental ones, oldest first. */
  async listPushedAlertTimes(patientId: string, sinceIso: string): Promise<string[]> {
    const result = await this.pool.query<{ at: Date }>(
      `SELECT notified_at AS at FROM rescue_carb_alerts WHERE patient_id = $1::uuid AND notified_at >= $2::timestamptz
       UNION
       SELECT reading_at FROM prediction_low_scores WHERE patient_id = $1::uuid AND pushed_to > 0 AND reading_at >= $2::timestamptz
       ORDER BY at`,
      [patientId, sinceIso],
    );
    return result.rows.map((row) => new Date(row.at).toISOString());
  }

  /**
   * What the rescue rules say for a reading the model scored (low-comparison.v1). The rules are asked every minute and
   * may change their mind within a reading: a warning once given stays. No row yet: nothing is written, the next minute tries again.
   */
  async recordRulesVerdict(patientId: string, readingAt: string, warning: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE prediction_low_scores SET rules_warning = coalesce(rules_warning, false) OR $3
        WHERE patient_id = $1::uuid AND reading_at = $2::timestamptz AND model_id = $4 AND rules_warning IS DISTINCT FROM true`,
      [patientId, readingAt, warning, LOW_RISK_MODEL_ID],
    );
  }

  readonly comparison = {
    rows: async (patientId: string): Promise<LowComparisonRow[]> => {
      const result = await this.pool.query<{ reading_at: Date; glucose_mgdl: number; alarm: boolean; rules_warning: boolean | null }>(
        `SELECT reading_at, glucose_mgdl, alarm, rules_warning FROM prediction_low_scores
          WHERE patient_id = $1::uuid AND model_id = $2 AND rules_warning IS NOT NULL ORDER BY reading_at`,
        [patientId, LOW_RISK_MODEL_ID],
      );
      return result.rows.map((row) => ({ reading_at: new Date(row.reading_at).toISOString(), glucose_mgdl: Number(row.glucose_mgdl), alarm: row.alarm, rules_warning: row.rules_warning }));
    },
    save: async (patientId: string, result: LowComparison, now: Date): Promise<{ notified: boolean }> => {
      const saved = await this.pool.query<{ notified_at: Date | null }>(
        `INSERT INTO prediction_low_comparisons (patient_id, result, computed_at) VALUES ($1::uuid, $2::jsonb, $3)
         ON CONFLICT (patient_id) DO UPDATE SET result = EXCLUDED.result, computed_at = EXCLUDED.computed_at
         RETURNING notified_at`,
        [patientId, JSON.stringify(result), now.toISOString()],
      );
      return { notified: Boolean(saved.rows[0]?.notified_at) };
    },
    /** Active iPhones of the patient's owners, one per push token. */
    listOwnerPushTokens: async (patientId: string): Promise<string[]> => {
      const result = await this.pool.query<{ push_token: string }>(
        `SELECT DISTINCT d.push_token FROM patient_devices d
          WHERE d.patient_id = $1::uuid AND d.platform = 'ios' AND d.active = true AND d.user_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM caregiver_relationships r WHERE r.user_id = d.user_id AND r.patient_id = d.patient_id AND r.is_owner)`,
        [patientId],
      );
      return result.rows.map((row) => row.push_token);
    },
    markNotified: async (patientId: string, now: Date): Promise<void> => {
      await this.pool.query(`UPDATE prediction_low_comparisons SET notified_at = $2 WHERE patient_id = $1::uuid AND notified_at IS NULL`, [patientId, now.toISOString()]);
    },
  };

  async prune(before: Date): Promise<void> {
    await this.pool.query(`DELETE FROM prediction_low_scores WHERE created_at < $1`, [before.toISOString()]);
  }
}

/** The rescue alert's and Teraz's reader of the model's verdict; undefined while the switch is off (v2 decides). */
export function lowRiskVerdictReader(pool: Pool, env: Record<string, string | undefined> = process.env): ((patientId: string, now: Date) => Promise<LowRiskVerdict | null>) | undefined {
  if (!isLowRiskRescueSource(env)) return undefined;
  const store = new PostgresLowRiskAlertRepository(pool);
  // Not listed: the rules decide, the model only scores in the background.
  return async (patientId, now) => ((await store.decidesAlert(patientId)) ? lowRiskVerdictOf(await store.latestScore(patientId), now) : null);
}
