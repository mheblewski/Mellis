import type { Pool } from 'pg';
import type { PredictionLateRise, PredictionPlanEvent, PredictionPlanKind } from '@modules/glucose-forecast/application/prediction-engine';
import { PREDICTION_PLAN_POLICY, type PredictionLogEntry, type PredictionStore, type StoredParams } from '@modules/glucose-forecast/application/prediction-service';
import type { SimpleLineParams } from '@modules/glucose-forecast/application/simple-line';
import { WBT_REMINDER_DELAY_MINUTES } from '@modules/meal-wbt/application/wbt-policy';

/** The prediction experiment's data (migrations 906, 907). Written only while the experiment is on for the patient. */
export class PostgresPredictionRepository implements PredictionStore {
  constructor(private readonly pool: Pool) {}

  async listOptedInPatients(): Promise<string[]> {
    const result = await this.pool.query<{ patient_id: string }>(`SELECT patient_id::text FROM prediction_experiment_optins WHERE enabled`);
    return result.rows.map((row) => row.patient_id);
  }

  async isOptedIn(patientId: string): Promise<boolean> {
    const result = await this.pool.query<{ enabled: boolean }>(`SELECT enabled FROM prediction_experiment_optins WHERE patient_id = $1::uuid`, [patientId]);
    return Boolean(result.rows[0]?.enabled);
  }

  async getParams(patientId: string, modelId: string): Promise<StoredParams | null> {
    const result = await this.pool.query<{ params: SimpleLineParams; fitted_at: Date }>(
      `SELECT params, fitted_at FROM prediction_params WHERE patient_id = $1::uuid AND model_id = $2`,
      [patientId, modelId],
    );
    const row = result.rows[0];
    return row ? { params: row.params, stored_at: new Date(row.fitted_at).toISOString() } : null;
  }

  async saveParams(patientId: string, params: SimpleLineParams, now: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO prediction_params (patient_id, model_id, params, fitted_at) VALUES ($1::uuid, $2, $3::jsonb, $4)
       ON CONFLICT (patient_id, model_id) DO UPDATE SET params = EXCLUDED.params, fitted_at = EXCLUDED.fitted_at`,
      [patientId, params.model_id, JSON.stringify(params), now.toISOString()],
    );
  }

  async log(entry: PredictionLogEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO prediction_log (patient_id, reading_at, model_id, glucose_mgdl, points, loop_main, after_carbs, hidden_reason)
       VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)
       ON CONFLICT (patient_id, reading_at, model_id) DO NOTHING`,
      [entry.patient_id, entry.reading_at, entry.model_id, entry.glucose_mgdl, JSON.stringify(entry.points), entry.loop_main ? JSON.stringify(entry.loop_main) : null, entry.after_carbs, entry.hidden_reason],
    );
  }

  /** Reads only. Each source is the row the app already acts on, so a marker goes when its plan goes. */
  async listPlan(patientId: string, now: Date): Promise<{ plan: PredictionPlanEvent[]; late_rise: PredictionLateRise[] }> {
    const { horizon_hours: horizon, past_minutes: past, late_rise_from_minutes: from, late_rise_to_minutes: to } = PREDICTION_PLAN_POLICY;
    const args = [patientId, now.toISOString(), `${horizon} hours`, `${past} minutes`];
    const parts = await this.pool.query<{ kind: PredictionPlanKind; at: Date; title: string | null; state: PredictionPlanEvent['state'] }>(
      `
        SELECT 'BOLUS_PART' AS kind, due_at AS at, NULL::text AS title,
               CASE WHEN status IN ('SCHEDULED', 'NOTIFIED') THEN 'PLANNED' WHEN status = 'GIVEN' THEN 'DONE_EARLY' ELSE 'SKIPPED' END AS state
          FROM planned_boluses
         WHERE patient_id = $1::uuid AND status IN ('SCHEDULED', 'NOTIFIED', 'GIVEN', 'SKIPPED')
           AND due_at > $2::timestamptz - $4::interval AND due_at <= $2::timestamptz + $3::interval
           AND (status IN ('SCHEDULED', 'NOTIFIED') OR due_at > $2::timestamptz)
        UNION ALL
        SELECT 'WBT_INSULIN', remind_at, NULL,
               CASE WHEN dose_given_at IS NOT NULL THEN 'DONE_EARLY' ELSE 'PLANNED' END
          FROM meal_wbt_reminders
         WHERE patient_id = $1::uuid AND enabled AND status = 'SCHEDULED'
           AND remind_at > $2::timestamptz - $4::interval AND remind_at <= $2::timestamptz + $3::interval
        UNION ALL
        SELECT CASE WHEN kind = 'MOVEMENT' THEN 'PLANNED_MOVEMENT' ELSE 'PLANNED_MEAL' END, planned_at, title, 'PLANNED'
          FROM meal_plan_entries
         WHERE patient_id = $1::uuid AND status = 'PLANNED'
           AND planned_at > $2::timestamptz AND planned_at <= $2::timestamptz + $3::interval
        UNION ALL
        SELECT 'REMINDER', due_at, NULL, 'PLANNED'
          FROM care_reminders
         WHERE patient_id = $1::uuid AND status = 'ACTIVE'
           AND due_at > $2::timestamptz AND due_at <= $2::timestamptz + $3::interval
        UNION ALL
        SELECT 'LATER_CARBS', (context->>'carbs_at')::timestamptz, NULL, 'PLANNED'
          FROM remote_commands
         WHERE patient_id = $1::uuid AND status IN ('SUCCEEDED', 'PARTIAL') AND carbs_g > 0
           AND created_at > $2::timestamptz - interval '1 hour'
           AND (context->>'carbs_at')::timestamptz > $2::timestamptz
        ORDER BY at
      `,
      args,
    );
    const rises = await this.pool.query<{ meal_record_id: string; remind_at: Date; status: string; dose_given_at: Date | null }>(
      `
        SELECT meal_record_id::text, remind_at, status, dose_given_at
          FROM meal_wbt_reminders
         WHERE patient_id = $1::uuid AND enabled
           AND remind_at > $2::timestamptz - make_interval(mins => $3)
           AND remind_at <= $2::timestamptz + $4::interval
         ORDER BY remind_at
      `,
      [patientId, now.toISOString(), to - WBT_REMINDER_DELAY_MINUTES, `${horizon} hours`],
    );
    return {
      plan: parts.rows.map((row) => ({ kind: row.kind, at: new Date(row.at).toISOString(), title: row.title, state: row.state })),
      late_rise: rises.rows.map((row) => {
        const start = new Date(row.remind_at).getTime() - WBT_REMINDER_DELAY_MINUTES * 60_000;
        return {
          meal_id: row.meal_record_id,
          from: new Date(start + from * 60_000).toISOString(),
          to: new Date(start + to * 60_000).toISOString(),
          insulin_planned: row.status === 'SCHEDULED' && !row.dose_given_at,
          insulin_given: Boolean(row.dose_given_at),
        };
      }),
    };
  }

  async pruneLog(before: Date): Promise<void> {
    await this.pool.query(`DELETE FROM prediction_log WHERE created_at < $1`, [before.toISOString()]);
  }
}
