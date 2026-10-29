import type { Pool } from 'pg';

export interface PostgresDatabaseIdentity {
  database: string;
  host: string;
  port: number;
}

function normalizeHost(host: string): string {
  const withoutCidr = host.split('/')[0]?.trim() ?? host;
  const normalized = withoutCidr.toLowerCase();

  if (normalized === '::1') {
    return 'localhost';
  }

  if (normalized === '127.0.0.1') {
    return 'localhost';
  }

  return normalized;
}

// A Docker-published Postgres (CI service container) reports its private bridge address, not localhost.
function isPrivateIpv4(host: string): boolean {
  return /^(10\.\d{1,3}|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}$/.test(host);
}

function isSameHost(actualHost: string, expectedHost: string, env: NodeJS.ProcessEnv): boolean {
  const actual = normalizeHost(actualHost);
  const expected = normalizeHost(expectedHost);
  if (actual === expected) {
    return true;
  }

  return env.TEST_DATABASE_ALLOW_CONTAINER_ADDR === '1' && expected === 'localhost' && isPrivateIpv4(actual);
}

function isLikelyTestDatabaseName(database: string): boolean {
  return /(^test($|_)|_test($|_)|test$)/i.test(database);
}

export function parsePostgresIdentityFromUrl(databaseUrl: string): PostgresDatabaseIdentity {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('Invalid TEST_DATABASE_URL: expected a valid PostgreSQL connection URL');
  }

  const database = parsed.pathname.replace(/^\/+/, '').trim();
  if (!database) {
    throw new Error('Invalid TEST_DATABASE_URL: database name is missing');
  }

  const host = parsed.hostname.trim();
  if (!host) {
    throw new Error('Invalid TEST_DATABASE_URL: host is missing');
  }

  const port = parsed.port ? Number(parsed.port) : 5432;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('Invalid TEST_DATABASE_URL: port must be a positive integer');
  }

  return {
    database,
    host,
    port,
  };
}

export function assertIntegrationTestDatabaseConfiguration(env: NodeJS.ProcessEnv): {
  testDatabaseUrl: string;
  identity: PostgresDatabaseIdentity;
} {
  const testDatabaseUrl = env.TEST_DATABASE_URL?.trim();
  if (!testDatabaseUrl) {
    throw new Error('Missing required environment variable: TEST_DATABASE_URL (required when RUN_POSTGRES_INTEGRATION=1)');
  }

  const identity = parsePostgresIdentityFromUrl(testDatabaseUrl);
  if (!isLikelyTestDatabaseName(identity.database)) {
    throw new Error(
      `Refusing integration test database because database name does not look isolated for tests: database=${identity.database}, host=${identity.host}, port=${identity.port}. Expected a dedicated test database name that includes "test".`,
    );
  }

  return {
    testDatabaseUrl,
    identity,
  };
}

export function configurePostgresIntegrationEnvironment(env: NodeJS.ProcessEnv): void {
  if (env.RUN_POSTGRES_INTEGRATION !== '1') {
    return;
  }

  const { testDatabaseUrl } = assertIntegrationTestDatabaseConfiguration(env);
  env.DATABASE_URL = testDatabaseUrl;
}

export async function assertPoolUsesIsolatedTestDatabase(
  pool: Pick<Pool, 'query'>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ expected: PostgresDatabaseIdentity; actual: PostgresDatabaseIdentity }> {
  const { identity: expected } = assertIntegrationTestDatabaseConfiguration(env);

  const result = await pool.query<{ database_name: string; host: string; port: string }>(`
    SELECT
      current_database()::text AS database_name,
      COALESCE(inet_server_addr()::text, 'localhost') AS host,
      COALESCE(inet_server_port()::text, '5432') AS port
  `);

  const row = result.rows[0];
  if (!row) {
    throw new Error('Unable to verify PostgreSQL connection identity for integration tests');
  }

  const actual: PostgresDatabaseIdentity = {
    database: String(row.database_name),
    host: String(row.host),
    port: Number(row.port),
  };

  const sameDatabase = actual.database === expected.database;
  const samePort = Number.isInteger(actual.port) && actual.port === expected.port;
  const sameHost = isSameHost(actual.host, expected.host, env);

  if (!sameDatabase || !samePort || !sameHost) {
    throw new Error(
      `Refusing destructive integration test operation: expected database=${expected.database}, host=${expected.host}, port=${expected.port} but connected to database=${actual.database}, host=${actual.host}, port=${actual.port}`,
    );
  }

  return { expected, actual };
}

export async function truncatePublicTablesForIntegrationTests(
  pool: Pick<Pool, 'query'>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await assertPoolUsesIsolatedTestDatabase(pool, env);

  const tablesResult = await pool.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name NOT IN ('schema_migrations')
    ORDER BY table_name
  `);

  const tableNames = tablesResult.rows.map((row) => `"${row.table_name}"`).join(', ');
  if (!tableNames) {
    return;
  }

  await pool.query(`TRUNCATE TABLE ${tableNames} CASCADE`);
}