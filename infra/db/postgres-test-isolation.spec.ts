import { describe, expect, it, vi } from 'vitest';
import {
  assertIntegrationTestDatabaseConfiguration,
  assertPoolUsesIsolatedTestDatabase,
  configurePostgresIntegrationEnvironment,
  truncatePublicTablesForIntegrationTests,
} from './postgres-test-isolation';

describe('postgres test isolation guard', () => {
  it('accepts explicit isolated test database configuration', () => {
    const config = assertIntegrationTestDatabaseConfiguration({
      RUN_POSTGRES_INTEGRATION: '1',
      TEST_DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/gluco_mind_test',
    });

    expect(config.identity.database).toBe('gluco_mind_test');
    expect(config.identity.host).toBe('localhost');
    expect(config.identity.port).toBe(5432);
  });

  it('rejects missing TEST_DATABASE_URL when postgres integration mode is enabled', () => {
    expect(() => configurePostgresIntegrationEnvironment({ RUN_POSTGRES_INTEGRATION: '1' })).toThrow(
      'Missing required environment variable: TEST_DATABASE_URL (required when RUN_POSTGRES_INTEGRATION=1)',
    );
  });

  it('rejects non-test database names', () => {
    expect(() => assertIntegrationTestDatabaseConfiguration({
      RUN_POSTGRES_INTEGRATION: '1',
      TEST_DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/gluco_mind',
    })).toThrow('Refusing integration test database because database name does not look isolated for tests');
  });

  it('refuses destructive truncate when connected database identity differs from configured test database', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('current_database')) {
        return {
          rows: [{
            database_name: 'gluco_mind',
            host: 'localhost',
            port: '5432',
          }],
        };
      }

      throw new Error('unexpected query');
    });

    await expect(
      truncatePublicTablesForIntegrationTests({ query } as any, {
        RUN_POSTGRES_INTEGRATION: '1',
        TEST_DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/gluco_mind_test',
      }),
    ).rejects.toThrow('Refusing destructive integration test operation');

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining('TRUNCATE TABLE'));
  });

  describe('Docker-published test database (CI service container)', () => {
    const env = {
      RUN_POSTGRES_INTEGRATION: '1',
      TEST_DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/gluco_mind_test',
    };
    const connectedTo = (database_name: string, host: string) => ({
      query: vi.fn(async () => ({ rows: [{ database_name, host, port: '5432' }] })),
    });

    it('refuses a private bridge address for localhost unless explicitly allowed', async () => {
      await expect(assertPoolUsesIsolatedTestDatabase(connectedTo('gluco_mind_test', '172.18.0.2/32') as any, env))
        .rejects.toThrow('Refusing destructive integration test operation');
    });

    it('accepts a private bridge address for localhost with TEST_DATABASE_ALLOW_CONTAINER_ADDR=1', async () => {
      await expect(assertPoolUsesIsolatedTestDatabase(connectedTo('gluco_mind_test', '172.18.0.2/32') as any, { ...env, TEST_DATABASE_ALLOW_CONTAINER_ADDR: '1' }))
        .resolves.toMatchObject({ actual: { database: 'gluco_mind_test' } });
    });

    it('still refuses a public address or another database with the flag set', async () => {
      const allowed = { ...env, TEST_DATABASE_ALLOW_CONTAINER_ADDR: '1' };
      await expect(assertPoolUsesIsolatedTestDatabase(connectedTo('gluco_mind_test', '203.0.113.7/32') as any, allowed))
        .rejects.toThrow('Refusing destructive integration test operation');
      await expect(assertPoolUsesIsolatedTestDatabase(connectedTo('gluco_mind', '172.18.0.2/32') as any, allowed))
        .rejects.toThrow('Refusing destructive integration test operation');
    });
  });
});
