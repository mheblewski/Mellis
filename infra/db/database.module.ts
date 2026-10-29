import { Global, Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { DATABASE_POOL } from './database.tokens';
import { PostgresGlucoMindRepository } from './postgres-glucomind.repository';
import { PostgresNightscoutRepository } from './postgres-nightscout.repository';
import { PostgresEvidenceExclusionRepository } from './postgres-evidence-exclusion.repository';
import { assertRequiredSchemaMigration } from './schema-readiness';

const poolLogger = new Logger('DatabasePool');

/**
 * The shared pool. An idle client whose connection dies (Postgres restarted, network cut) makes the pool emit 'error';
 * without a listener Node treats it as unhandled and stops the API or the worker. The pool has already dropped that
 * client and opens a new connection for the next query, so the error is only logged.
 */
export function createDatabasePool(connectionString: string): Pool {
  const pool = new Pool({ connectionString });
  pool.on('error', (error) => {
    const details = error as Error & { code?: unknown };
    poolLogger.warn(JSON.stringify({ event: 'database_idle_client_error', code: typeof details.code === 'string' ? details.code : null, message: details.message }));
  });
  return pool;
}

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: DATABASE_POOL,
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => {
        const pool = createDatabasePool(configService.getOrThrow<string>('DATABASE_URL'));

        try {
          await assertRequiredSchemaMigration(pool);
          return pool;
        } catch (error) {
          await pool.end();
          throw error;
        }
      },
    },
    PostgresGlucoMindRepository,
    PostgresNightscoutRepository,
    PostgresEvidenceExclusionRepository,
  ],
  exports: [
    DATABASE_POOL,
    PostgresGlucoMindRepository,
    PostgresNightscoutRepository,
    PostgresEvidenceExclusionRepository,
  ],
})
export class DatabaseModule {}