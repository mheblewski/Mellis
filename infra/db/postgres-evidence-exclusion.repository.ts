import { Inject, Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { NotFoundError } from '@shared/errors/app-error';
import { DATABASE_POOL } from './database.tokens';
import type {
  EvidenceExclusionReasonSubcode,
  EvidenceExclusionRecord,
  EvidenceExclusionTargetKind,
} from '@modules/evidence-exclusion/domain/evidence-exclusion';
import type {
  EventSourceRecordLink,
  EvidenceEligibilityResolution,
  EvidenceExclusionRepository,
  EvidenceTargetRef,
} from '@modules/evidence-exclusion/application/evidence-exclusion.repository';

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

@Injectable()
export class PostgresEvidenceExclusionRepository implements EvidenceExclusionRepository {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

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

  async assertTargetOwnedByPatient(args: { patient_id: string; target_kind: EvidenceExclusionTargetKind; target_id: string }, txClient?: PoolClient): Promise<void> {
    const queryable = txClient ?? this.pool;

    if (args.target_kind === 'EVENT') {
      const result = await queryable.query<{ id: string }>(
        `
          SELECT id::text
          FROM events
          WHERE id = $1::uuid
            AND patient_id = $2::uuid
          LIMIT 1
        `,
        [args.target_id, args.patient_id],
      );

      if (!result.rows[0]) {
        throw new NotFoundError(`Event not found for patient ${args.patient_id}`);
      }

      return;
    }

    const result = await queryable.query<{ id: string }>(
      `
        SELECT id::text
        FROM source_records
        WHERE id = $1::uuid
          AND patient_id = $2::uuid
        LIMIT 1
      `,
      [args.target_id, args.patient_id],
    );

    if (!result.rows[0]) {
      throw new NotFoundError(`Source record not found for patient ${args.patient_id}`);
    }
  }

  async getByIdentity(args: { patient_id: string; exclusion_identity: string }, txClient?: PoolClient): Promise<EvidenceExclusionRecord | null> {
    const queryable = txClient ?? this.pool;
    const result = await queryable.query<EvidenceExclusionRecord>(
      `
        SELECT *
        FROM evidence_exclusions
        WHERE patient_id = $1::uuid
          AND exclusion_identity = $2
        LIMIT 1
      `,
      [args.patient_id, args.exclusion_identity],
    );

    return result.rows[0] ? this.toExclusionRow(result.rows[0]) : null;
  }

  async getById(args: { patient_id: string; evidence_exclusion_id: string }, txClient?: PoolClient): Promise<EvidenceExclusionRecord | null> {
    const queryable = txClient ?? this.pool;
    const result = await queryable.query<EvidenceExclusionRecord>(
      `
        SELECT *
        FROM evidence_exclusions
        WHERE patient_id = $1::uuid
          AND evidence_exclusion_id = $2::uuid
        LIMIT 1
      `,
      [args.patient_id, args.evidence_exclusion_id],
    );

    return result.rows[0] ? this.toExclusionRow(result.rows[0]) : null;
  }

  async resolveAuthoritativeEligibility(args: { patient_id: string; target_kind: EvidenceExclusionTargetKind; target_id: string }, txClient?: PoolClient): Promise<EvidenceEligibilityResolution> {
    const queryable = txClient ?? this.pool;
    const result = await queryable.query<{ evidence_exclusion_id: string }>(
      `
        SELECT evidence_exclusion_id::text
        FROM evidence_exclusions
        WHERE patient_id = $1::uuid
          AND target_kind = $2
          AND target_id = $3::uuid
          AND lifecycle_status = 'ACTIVE'
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [args.patient_id, args.target_kind, args.target_id],
    );

    const activeExclusionId = result.rows[0]?.evidence_exclusion_id ?? null;

    return {
      patient_id: args.patient_id,
      target_kind: args.target_kind,
      target_id: args.target_id,
      authoritative_eligibility: activeExclusionId ? 'EXCLUDED' : 'USABLE',
      active_exclusion_id: activeExclusionId,
    };
  }

  async listEventSourceRecordLinks(args: { patient_id: string; event_ids: string[] }, txClient?: PoolClient): Promise<EventSourceRecordLink[]> {
    const queryable = txClient ?? this.pool;
    if (args.event_ids.length === 0) {
      return [];
    }

    const result = await queryable.query<{ event_id: string; source_record_id: string }>(
      `
        SELECT id::text AS event_id, source_record_id::text AS source_record_id
        FROM events
        WHERE patient_id = $1::uuid
          AND id = ANY($2::uuid[])
          AND source_record_id IS NOT NULL
      `,
      [args.patient_id, args.event_ids],
    );

    return result.rows;
  }

  async listActiveExclusionTargets(args: { patient_id: string; targets: EvidenceTargetRef[] }, txClient?: PoolClient): Promise<EvidenceTargetRef[]> {
    const queryable = txClient ?? this.pool;
    if (args.targets.length === 0) {
      return [];
    }

    const eventIds = args.targets
      .filter((target) => target.target_kind === 'EVENT')
      .map((target) => target.target_id);

    const sourceRecordIds = args.targets
      .filter((target) => target.target_kind === 'SOURCE_RECORD')
      .map((target) => target.target_id);

    if (eventIds.length === 0 && sourceRecordIds.length === 0) {
      return [];
    }

    const result = await queryable.query<{ target_kind: EvidenceExclusionTargetKind; target_id: string }>(
      `
        SELECT target_kind, target_id::text
        FROM evidence_exclusions
        WHERE patient_id = $1::uuid
          AND lifecycle_status = 'ACTIVE'
          AND (
            ($2::uuid[] <> '{}'::uuid[] AND target_kind = 'EVENT' AND target_id = ANY($2::uuid[]))
            OR ($3::uuid[] <> '{}'::uuid[] AND target_kind = 'SOURCE_RECORD' AND target_id = ANY($3::uuid[]))
          )
      `,
      [args.patient_id, eventIds, sourceRecordIds],
    );

    return result.rows.map((row) => ({ target_kind: row.target_kind, target_id: row.target_id }));
  }

  private toExclusionRow(row: EvidenceExclusionRecord): EvidenceExclusionRecord {
    return {
      ...row,
      reason_subcode: (row.reason_subcode ?? null) as EvidenceExclusionReasonSubcode | null,
      provenance: parseJsonObject(row.provenance),
      revocation_provenance: row.revocation_provenance ? parseJsonObject(row.revocation_provenance) : null,
    };
  }

}
