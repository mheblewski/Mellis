import { describe, expect, it } from 'vitest';
import { parseBoolean, parseWorkerJobTypes, readBooleanFlag, validateApiEnvironment, validateWorkerEnvironment } from './environment';

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgresql://localhost:5432/gluco_mind',
    NIGHTSCOUT_BASE_URL: 'https://nightscout.example.com',
    NIGHTSCOUT_API_TOKEN: 'synthetic-nightscout-credential',
    NIGHTSCOUT_PATIENT_ID: '11111111-1111-4111-8111-111111111111',
    NIGHTSCOUT_TOKEN_ENCRYPTION_KEY: '00'.repeat(32),
    AI_PROVIDER: 'fake',
    PUSH_PROVIDER: 'fake',
    ...overrides,
  };
}

const COGNITO_API_ENV = {
  DATABASE_URL: 'postgresql://localhost:5432/gluco_mind',
  COGNITO_USER_POOL_ID: 'eu-central-1_Example',
  COGNITO_CLIENT_ID: 'abc123client',
};

describe('boolean flags', () => {
  it('parse true/1 and false/0 in any case, with the fallback when unset or empty', () => {
    expect(parseBoolean({ X: ' TRUE ' }, 'X', false)).toBe(true);
    expect(parseBoolean({ X: '1' }, 'X', false)).toBe(true);
    expect(parseBoolean({ X: 'False' }, 'X', true)).toBe(false);
    expect(parseBoolean({ X: '0' }, 'X', true)).toBe(false);
    expect(parseBoolean({ X: '' }, 'X', true)).toBe(true);
    expect(parseBoolean({}, 'X', false)).toBe(false);
    expect(() => parseBoolean({ X: 'yes' }, 'X', false)).toThrow('Invalid environment variable: X must be true/false or 1/0');
  });

  it('read at run time: the same values, an invalid one is off instead of throwing', () => {
    expect(readBooleanFlag({ REMOTE_COMMANDS_ENABLED: 'true' }, 'REMOTE_COMMANDS_ENABLED')).toBe(true);
    expect(readBooleanFlag({ REMOTE_COMMANDS_ENABLED: 'on' }, 'REMOTE_COMMANDS_ENABLED')).toBe(false);
    expect(readBooleanFlag({ REMOTE_COMMANDS_ENABLED: 'treu' }, 'REMOTE_COMMANDS_ENABLED')).toBe(false);
    expect(readBooleanFlag({}, 'REMOTE_COMMANDS_ENABLED')).toBe(false);
  });
});

describe('validateApiEnvironment runtime settings', () => {
  it('validates the flags, photo directory, Nightscout auth mode and minimum build the API reads', () => {
    const validated = validateApiEnvironment({
      ...COGNITO_API_ENV,
      REMOTE_COMMANDS_ENABLED: '1',
      AI_ENABLE_MEAL_ACTIONS: 'false',
      MEAL_PHOTO_DIR: ' /data/photos ',
      NIGHTSCOUT_AUTH_MODE: 'api_secret_sha1',
      IOS_MIN_SUPPORTED_BUILD: '0',
    });
    expect(validated).toMatchObject({
      REMOTE_COMMANDS_ENABLED: true,
      AI_ENABLE_MEAL_ACTIONS: false,
      MEAL_PHOTO_DIR: '/data/photos',
      NIGHTSCOUT_AUTH_MODE: 'API_SECRET_SHA1',
      IOS_MIN_SUPPORTED_BUILD: 0,
    });
    expect(validateApiEnvironment(COGNITO_API_ENV)).toMatchObject({ REMOTE_COMMANDS_ENABLED: false, AI_ENABLE_MEAL_ACTIONS: false, NIGHTSCOUT_AUTH_MODE: 'BEARER' });
  });

  it('stops the start on a flag typo, an unknown Nightscout auth mode or a bad minimum build', () => {
    expect(() => validateApiEnvironment({ ...COGNITO_API_ENV, REMOTE_COMMANDS_ENABLED: 'yes' })).toThrow('REMOTE_COMMANDS_ENABLED must be true/false or 1/0');
    expect(() => validateApiEnvironment({ ...COGNITO_API_ENV, AI_ENABLE_MEAL_ACTIONS: 'tru' })).toThrow('AI_ENABLE_MEAL_ACTIONS must be true/false or 1/0');
    expect(() => validateApiEnvironment({ ...COGNITO_API_ENV, NIGHTSCOUT_AUTH_MODE: 'BASIC' })).toThrow('NIGHTSCOUT_AUTH_MODE must be BEARER, API_SECRET_SHA1 or ACCESS_TOKEN_JWT');
    expect(() => validateApiEnvironment({ ...COGNITO_API_ENV, IOS_MIN_SUPPORTED_BUILD: '-1' })).toThrow('IOS_MIN_SUPPORTED_BUILD must be a whole number >= 0');
  });

  it('the worker refuses the same flag typos', () => {
    expect(() => validateWorkerEnvironment(baseEnv({ REMOTE_COMMANDS_ENABLED: 'on' }))).toThrow('REMOTE_COMMANDS_ENABLED must be true/false or 1/0');
    expect(() => validateWorkerEnvironment(baseEnv({ AI_ENABLE_MEAL_ACTIONS: 'yes' }))).toThrow('AI_ENABLE_MEAL_ACTIONS must be true/false or 1/0');
  });
});

describe('validateApiEnvironment', () => {
  it('requires Cognito settings in default mode', () => {
    const validated = validateApiEnvironment({
      DATABASE_URL: 'postgresql://localhost:5432/gluco_mind',
      COGNITO_USER_POOL_ID: 'eu-central-1_Example',
      COGNITO_CLIENT_ID: 'abc123client',
      COGNITO_TOKEN_USE: 'access',
    });

    expect(validated.AUTH_MODE).toBe('cognito');
    expect(validated.COGNITO_USER_POOL_ID).toBe('eu-central-1_Example');
    expect(validated.COGNITO_CLIENT_ID).toBe('abc123client');
    expect(validated.COGNITO_TOKEN_USE).toBe('access');
  });

  it('defaults token use to access', () => {
    const validated = validateApiEnvironment({
      DATABASE_URL: 'postgresql://localhost:5432/gluco_mind',
      COGNITO_USER_POOL_ID: 'eu-central-1_Example',
      COGNITO_CLIENT_ID: 'abc123client',
    });

    expect(validated.COGNITO_TOKEN_USE).toBe('access');
  });

  it('rejects unsupported token use', () => {
    expect(() => validateApiEnvironment({
      DATABASE_URL: 'postgresql://localhost:5432/gluco_mind',
      COGNITO_USER_POOL_ID: 'eu-central-1_Example',
      COGNITO_CLIENT_ID: 'abc123client',
      COGNITO_TOKEN_USE: 'custom',
    })).toThrow('Invalid environment variable: COGNITO_TOKEN_USE must be access or id');
  });

  it('allows AUTH_MODE=disabled only in explicit local/dev environments', () => {
    const validated = validateApiEnvironment({
      DATABASE_URL: 'postgresql://localhost:5432/gluco_mind',
      AUTH_MODE: 'disabled',
      NODE_ENV: 'development',
      ALLOW_AUTH_DISABLED_IN_LOCAL: 'true',
      AUTH_DISABLED_USER_ID: '11111111-1111-4111-8111-111111111111',
    });

    expect(validated.AUTH_MODE).toBe('disabled');
    expect(validated.AUTH_DISABLED_USER_ID).toBe('11111111-1111-4111-8111-111111111111');
    expect(validated.COGNITO_USER_POOL_ID).toBeUndefined();
  });

  it('fails closed when AUTH_MODE=disabled is requested in production', () => {
    expect(() => validateApiEnvironment({
      DATABASE_URL: 'postgresql://localhost:5432/gluco_mind',
      AUTH_MODE: 'disabled',
      NODE_ENV: 'production',
      ALLOW_AUTH_DISABLED_IN_LOCAL: 'true',
    })).toThrow(
      'Invalid environment variables: AUTH_MODE=disabled requires NODE_ENV to be development/local/test and ALLOW_AUTH_DISABLED_IN_LOCAL=true',
    );
  });

  it('fails closed when explicit local bypass flag is missing', () => {
    expect(() => validateApiEnvironment({
      DATABASE_URL: 'postgresql://localhost:5432/gluco_mind',
      AUTH_MODE: 'disabled',
      NODE_ENV: 'development',
      ALLOW_AUTH_DISABLED_IN_LOCAL: 'false',
    })).toThrow(
      'Invalid environment variables: AUTH_MODE=disabled requires NODE_ENV to be development/local/test and ALLOW_AUTH_DISABLED_IN_LOCAL=true',
    );
  });
});

describe('validateWorkerEnvironment', () => {
  it('defaults NIGHTSCOUT_AUTH_MODE to BEARER', () => {
    const validated = validateWorkerEnvironment(baseEnv({ NIGHTSCOUT_AUTH_MODE: undefined }));
    expect(validated.NIGHTSCOUT_AUTH_MODE).toBe('BEARER');
  });

  it('accepts explicit BEARER mode', () => {
    const validated = validateWorkerEnvironment(baseEnv({ NIGHTSCOUT_AUTH_MODE: 'BEARER' }));
    expect(validated.NIGHTSCOUT_AUTH_MODE).toBe('BEARER');
  });

  it('accepts explicit API_SECRET_SHA1 mode', () => {
    const validated = validateWorkerEnvironment(baseEnv({ NIGHTSCOUT_AUTH_MODE: 'API_SECRET_SHA1' }));
    expect(validated.NIGHTSCOUT_AUTH_MODE).toBe('API_SECRET_SHA1');
  });

  it('rejects invalid NIGHTSCOUT_AUTH_MODE', () => {
    expect(() => validateWorkerEnvironment(baseEnv({ NIGHTSCOUT_AUTH_MODE: 'INVALID' }))).toThrow(
      'Invalid environment variable: NIGHTSCOUT_AUTH_MODE must be BEARER, API_SECRET_SHA1 or ACCESS_TOKEN_JWT',
    );
  });

  it('defaults NIGHTSCOUT_SYNC_LOOKBACK_MINUTES to 6 h, accepts 0 and rejects negative values', () => {
    expect(validateWorkerEnvironment(baseEnv({ NIGHTSCOUT_SYNC_LOOKBACK_MINUTES: undefined })).NIGHTSCOUT_SYNC_LOOKBACK_MINUTES).toBe(360);
    expect(validateWorkerEnvironment(baseEnv({ NIGHTSCOUT_SYNC_LOOKBACK_MINUTES: '0' })).NIGHTSCOUT_SYNC_LOOKBACK_MINUTES).toBe(0);
    expect(() => validateWorkerEnvironment(baseEnv({ NIGHTSCOUT_SYNC_LOOKBACK_MINUTES: '-5' }))).toThrow('NIGHTSCOUT_SYNC_LOOKBACK_MINUTES');
  });

  it('defaults the Nightscout history import to 30 days (device statuses 7) and rejects 0 or more than a year', () => {
    const validated = validateWorkerEnvironment(baseEnv({ NIGHTSCOUT_INITIAL_HISTORY_DAYS: undefined, NIGHTSCOUT_INITIAL_DEVICESTATUS_DAYS: undefined }));
    expect([validated.NIGHTSCOUT_INITIAL_HISTORY_DAYS, validated.NIGHTSCOUT_INITIAL_DEVICESTATUS_DAYS]).toEqual([30, 7]);
    expect(validateWorkerEnvironment(baseEnv({ NIGHTSCOUT_INITIAL_HISTORY_DAYS: '90' })).NIGHTSCOUT_INITIAL_HISTORY_DAYS).toBe(90);
    expect(() => validateWorkerEnvironment(baseEnv({ NIGHTSCOUT_INITIAL_HISTORY_DAYS: '0' }))).toThrow('NIGHTSCOUT_INITIAL_HISTORY_DAYS');
    expect(() => validateWorkerEnvironment(baseEnv({ NIGHTSCOUT_INITIAL_DEVICESTATUS_DAYS: '400' }))).toThrow('NIGHTSCOUT_INITIAL_DEVICESTATUS_DAYS must be at most 365');
  });

  it('defaults NIGHTSCOUT_SYNC_MAX_ENTRY_PAGES when omitted', () => {
    const validated = validateWorkerEnvironment(baseEnv({ NIGHTSCOUT_SYNC_MAX_ENTRY_PAGES: undefined }));
    expect(validated.NIGHTSCOUT_SYNC_MAX_ENTRY_PAGES).toBe(24);
  });

  it('accepts explicit NIGHTSCOUT_SYNC_MAX_ENTRY_PAGES', () => {
    const validated = validateWorkerEnvironment(baseEnv({ NIGHTSCOUT_SYNC_MAX_ENTRY_PAGES: '7' }));
    expect(validated.NIGHTSCOUT_SYNC_MAX_ENTRY_PAGES).toBe(7);
  });

  it('rejects non-positive NIGHTSCOUT_SYNC_MAX_ENTRY_PAGES', () => {
    expect(() => validateWorkerEnvironment(baseEnv({ NIGHTSCOUT_SYNC_MAX_ENTRY_PAGES: '0' }))).toThrow(
      'Invalid environment variable: NIGHTSCOUT_SYNC_MAX_ENTRY_PAGES must be a positive integer',
    );
  });

  it('keeps NIGHTSCOUT_SYNC_ENABLED on by default and parses an explicit false', () => {
    expect(validateWorkerEnvironment(baseEnv()).NIGHTSCOUT_SYNC_ENABLED).toBe(true);
    expect(validateWorkerEnvironment(baseEnv({ NIGHTSCOUT_SYNC_ENABLED: 'false' })).NIGHTSCOUT_SYNC_ENABLED).toBe(false);
    expect(validateWorkerEnvironment(baseEnv({ NIGHTSCOUT_SYNC_ENABLED: '0' })).NIGHTSCOUT_SYNC_ENABLED).toBe(false);
  });

  it('rejects a malformed NIGHTSCOUT_SYNC_ENABLED', () => {
    expect(() => validateWorkerEnvironment(baseEnv({ NIGHTSCOUT_SYNC_ENABLED: 'off' }))).toThrow(
      'Invalid environment variable: NIGHTSCOUT_SYNC_ENABLED must be true/false or 1/0',
    );
  });

  it('validates worker env defaults without delivery mode controls', () => {
    const validated = validateWorkerEnvironment(baseEnv());
    expect(validated.AI_PROVIDER).toBe('fake');
  });

  it('rejects a partial Nightscout seed (an empty NIGHTSCOUT_API_TOKEN) and accepts none at all', () => {
    expect(() => validateWorkerEnvironment(baseEnv({ NIGHTSCOUT_API_TOKEN: '   ' }))).toThrow(
      'Missing required environment variables for the Nightscout seed: NIGHTSCOUT_API_TOKEN',
    );
    const none = validateWorkerEnvironment(baseEnv({ NIGHTSCOUT_API_TOKEN: undefined, NIGHTSCOUT_BASE_URL: undefined, NIGHTSCOUT_PATIENT_ID: undefined }));
    expect(none.NIGHTSCOUT_PATIENT_ID).toBeUndefined();
  });

  it('requires a 32-byte NIGHTSCOUT_TOKEN_ENCRYPTION_KEY while the sync is on, without echoing it', () => {
    expect(() => validateWorkerEnvironment(baseEnv({ NIGHTSCOUT_TOKEN_ENCRYPTION_KEY: undefined }))).toThrow('NIGHTSCOUT_TOKEN_ENCRYPTION_KEY');
    expect(validateWorkerEnvironment(baseEnv({ NIGHTSCOUT_TOKEN_ENCRYPTION_KEY: undefined, NIGHTSCOUT_SYNC_ENABLED: 'false' })).NIGHTSCOUT_SYNC_ENABLED).toBe(false);
    expect(() => validateWorkerEnvironment(baseEnv({ NIGHTSCOUT_TOKEN_ENCRYPTION_KEY: 'short-secret' }))).toThrow(/must be 32 bytes \(64 hex characters or base64\)$/);
    expect(validateWorkerEnvironment(baseEnv({ NIGHTSCOUT_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') })).NIGHTSCOUT_TOKEN_ENCRYPTION_KEY).toBeDefined();
  });

  it('keeps the beta allowlist on unless BETA_ALLOWLIST_ENABLED=false', () => {
    expect(validateWorkerEnvironment(baseEnv()).BETA_ALLOWLIST_ENABLED).toBe(true);
    expect(validateWorkerEnvironment(baseEnv({ BETA_ALLOWLIST_ENABLED: 'false' })).BETA_ALLOWLIST_ENABLED).toBe(false);
  });
});

describe('WORKER_JOB_TYPES', () => {
  it('is undefined when unset, so the worker keeps claiming every job type', () => {
    expect(validateWorkerEnvironment(baseEnv()).WORKER_JOB_TYPES).toBeUndefined();
  });

  it('parses several comma-separated job types, trimming and de-duplicating', () => {
    expect(validateWorkerEnvironment(baseEnv({ WORKER_JOB_TYPES: ' nightscout.sync, meal.wbt_suggestion ,nightscout.sync' })).WORKER_JOB_TYPES)
      .toEqual(['nightscout.sync', 'meal.wbt_suggestion']);
  });

  it('refuses a set but empty or malformed list instead of falling back to all job types', () => {
    for (const value of ['', ' ', ',', ' , ']) {
      expect(() => parseWorkerJobTypes(value)).toThrow('WORKER_JOB_TYPES is set but empty');
    }
    for (const value of ['nightscout.sync,', 'nightscout sync', 'NIGHTSCOUT.SYNC', 'nightscout', '*', 'nightscout.sync;meal.wbt_suggestion']) {
      expect(() => parseWorkerJobTypes(value)).toThrow('WORKER_JOB_TYPES contains invalid job types');
    }
    expect(() => validateWorkerEnvironment(baseEnv({ WORKER_JOB_TYPES: '' }))).toThrow();
  });
});

describe('validateWorkerEnvironment AI cost guard', () => {
  const openAiEnv = (overrides: Record<string, string | undefined> = {}) => baseEnv({
    AI_PROVIDER: 'openai',
    OPENAI_API_KEY: 'synthetic-test-key',
    AI_BUDGETED_USAGE_SESSION: 'true',
    AI_EXPERIMENT_MAX_COST: '0.5',
    AI_EXPERIMENT_COST_CURRENCY: 'USD',
    AI_EXPERIMENT_MAX_OUTPUT_TOKENS: '1500',
    AI_EXPERIMENT_BUDGET_LEDGER_PATH: '/synthetic/outside-repo/ledger.json',
    ...overrides,
  });

  it('accepts openai for every job type in a budgeted usage session with an explicit cost guard', () => {
    const validated = validateWorkerEnvironment(openAiEnv());
    expect(validated.AI_BUDGETED_USAGE_SESSION).toBe(true);
    expect(validated.AI_EXPERIMENT_MAX_COST).toBe(0.5);
    expect(validated.AI_EXPERIMENT_COST_CURRENCY).toBe('USD');
    expect(validated.AI_EXPERIMENT_MAX_OUTPUT_TOKENS).toBe(1500);
    expect(validated.WORKER_JOB_TYPES).toBeUndefined();
  });

  it('refuses openai without a budgeted usage session', () => {
    expect(() => validateWorkerEnvironment(openAiEnv({ AI_BUDGETED_USAGE_SESSION: undefined })))
      .toThrow('AI_PROVIDER=openai requires AI_BUDGETED_USAGE_SESSION=true');
    expect(() => validateWorkerEnvironment(openAiEnv({ AI_BUDGETED_USAGE_SESSION: 'false' })))
      .toThrow('AI_PROVIDER=openai requires AI_BUDGETED_USAGE_SESSION=true');
  });

  it('refuses a leftover AI_SINGLE_CALL_EXPERIMENT=true, and ignores false', () => {
    expect(() => validateWorkerEnvironment(openAiEnv({ AI_SINGLE_CALL_EXPERIMENT: 'true' }))).toThrow('AI_SINGLE_CALL_EXPERIMENT was removed');
    expect(() => validateWorkerEnvironment(baseEnv({ AI_SINGLE_CALL_EXPERIMENT: '1' }))).toThrow('AI_SINGLE_CALL_EXPERIMENT was removed');
    expect(validateWorkerEnvironment(openAiEnv({ AI_SINGLE_CALL_EXPERIMENT: 'false' })).AI_BUDGETED_USAGE_SESSION).toBe(true);
  });

  it('refuses openai when any cost guard value is missing, without a default', () => {
    for (const key of ['AI_EXPERIMENT_MAX_COST', 'AI_EXPERIMENT_COST_CURRENCY', 'AI_EXPERIMENT_MAX_OUTPUT_TOKENS', 'AI_EXPERIMENT_BUDGET_LEDGER_PATH']) {
      expect(() => validateWorkerEnvironment(openAiEnv({ [key]: undefined }))).toThrow(key);
    }
    expect(() => validateWorkerEnvironment(openAiEnv({ AI_EXPERIMENT_MAX_COST: '0' }))).toThrow('AI_EXPERIMENT_MAX_COST must be a positive number');
    expect(() => validateWorkerEnvironment(openAiEnv({ AI_EXPERIMENT_MAX_OUTPUT_TOKENS: '1.5' }))).toThrow('AI_EXPERIMENT_MAX_OUTPUT_TOKENS must be a positive integer');
  });

  it('keeps the fake provider usable without a cost guard', () => {
    const validated = validateWorkerEnvironment(baseEnv());
    expect(validated.AI_BUDGETED_USAGE_SESSION).toBe(false);
    expect(validated.AI_EXPERIMENT_MAX_COST).toBeUndefined();
  });
});

describe('validateWorkerEnvironment NIGHTSCOUT_AUTH_MODE=ACCESS_TOKEN_JWT', () => {
  it('accepts the access-token JWT mode, case-insensitively', () => {
    expect(validateWorkerEnvironment(baseEnv({ NIGHTSCOUT_AUTH_MODE: 'ACCESS_TOKEN_JWT' })).NIGHTSCOUT_AUTH_MODE).toBe('ACCESS_TOKEN_JWT');
    expect(validateWorkerEnvironment(baseEnv({ NIGHTSCOUT_AUTH_MODE: 'access_token_jwt' })).NIGHTSCOUT_AUTH_MODE).toBe('ACCESS_TOKEN_JWT');
  });
});

describe('validateWorkerEnvironment OPENAI_REASONING_EFFORT', () => {
  it('accepts every allowed value', () => {
    for (const effort of ['none', 'low', 'medium', 'high', 'xhigh', 'max']) {
      expect(validateWorkerEnvironment(baseEnv({ OPENAI_REASONING_EFFORT: effort })).OPENAI_REASONING_EFFORT).toBe(effort);
    }
  });

  it('rejects unknown values with a readable error', () => {
    for (const effort of ['minimal', 'lowest', 'LOW', 'Low', 'auto', '1']) {
      expect(() => validateWorkerEnvironment(baseEnv({ OPENAI_REASONING_EFFORT: effort })))
        .toThrow('OPENAI_REASONING_EFFORT must be one of none, low, medium, high, xhigh, max');
    }
  });

  it('stays unset when not configured', () => {
    expect(validateWorkerEnvironment(baseEnv()).OPENAI_REASONING_EFFORT).toBeUndefined();
    expect(validateWorkerEnvironment(baseEnv({ OPENAI_REASONING_EFFORT: '' })).OPENAI_REASONING_EFFORT).toBeUndefined();
  });
});

describe('validateWorkerEnvironment with AI_PROVIDER=anthropic', () => {
  const anthropicEnv = (overrides: Record<string, string | undefined> = {}) => baseEnv({
    AI_PROVIDER: 'anthropic',
    ANTHROPIC_API_KEY: 'synthetic-test-key',
    AI_BUDGETED_USAGE_SESSION: 'true',
    AI_EXPERIMENT_MAX_COST: '0.5',
    AI_EXPERIMENT_COST_CURRENCY: 'USD',
    AI_EXPERIMENT_MAX_OUTPUT_TOKENS: '8000',
    AI_EXPERIMENT_BUDGET_LEDGER_PATH: '/synthetic/outside-repo/ledger.json',
    ...overrides,
  });

  it('accepts anthropic with its key and the same cost guard as openai, without an OpenAI key', () => {
    const validated = validateWorkerEnvironment(anthropicEnv());
    expect(validated.AI_PROVIDER).toBe('anthropic');
    expect(validated.ANTHROPIC_MODEL).toBe('claude-opus-5-5');
    expect(validated.ANTHROPIC_EFFORT).toBeUndefined();
    expect(validated.ANTHROPIC_REFUSAL_FALLBACK).toBe(true);
    expect(validated.OPENAI_API_KEY).toBeUndefined();
  });

  it('reads the model, effort and fallback switch', () => {
    const validated = validateWorkerEnvironment(anthropicEnv({ ANTHROPIC_MODEL: 'claude-sonnet-5-5', ANTHROPIC_EFFORT: 'low', ANTHROPIC_REFUSAL_FALLBACK: 'false' }));
    expect(validated).toMatchObject({ ANTHROPIC_MODEL: 'claude-sonnet-5-5', ANTHROPIC_EFFORT: 'low', ANTHROPIC_REFUSAL_FALLBACK: false });
  });

  it('refuses a missing key, an invalid effort and a missing cost guard', () => {
    expect(() => validateWorkerEnvironment(anthropicEnv({ ANTHROPIC_API_KEY: undefined }))).toThrow('Missing required environment variable: ANTHROPIC_API_KEY');
    expect(() => validateWorkerEnvironment(anthropicEnv({ ANTHROPIC_EFFORT: 'minimal' }))).toThrow(/ANTHROPIC_EFFORT/);
    expect(() => validateWorkerEnvironment(anthropicEnv({ AI_BUDGETED_USAGE_SESSION: undefined }))).toThrow('AI_PROVIDER=anthropic requires AI_BUDGETED_USAGE_SESSION=true');
    expect(() => validateWorkerEnvironment(anthropicEnv({ AI_EXPERIMENT_MAX_COST: undefined }))).toThrow('Missing required environment variables for AI_PROVIDER=anthropic: AI_EXPERIMENT_MAX_COST');
  });

  it('still refuses an unknown provider', () => {
    expect(() => validateWorkerEnvironment(baseEnv({ AI_PROVIDER: 'gemini' }))).toThrow('AI_PROVIDER must be fake, openai or anthropic');
  });
});

describe('validateApiEnvironment AUTH_MODE=device', () => {
  const DEVICE_ENV = { DATABASE_URL: 'postgresql://localhost/mellis', AUTH_MODE: 'device', NIGHTSCOUT_TOKEN_ENCRYPTION_KEY: '11'.repeat(32) };

  it('needs no Cognito, but the Nightscout token key; the setup code is optional and long', () => {
    expect(validateApiEnvironment(DEVICE_ENV)).toMatchObject({ AUTH_MODE: 'device', SETUP_CODE: undefined });
    expect(validateApiEnvironment({ ...DEVICE_ENV, SETUP_CODE: 'ABCDE-FGHJK-MNPQR-STVWX', PUBLIC_BASE_URL: 'https://mellis.example' }))
      .toMatchObject({ SETUP_CODE: 'ABCDE-FGHJK-MNPQR-STVWX', PUBLIC_BASE_URL: 'https://mellis.example' });
    expect(() => validateApiEnvironment({ ...DEVICE_ENV, NIGHTSCOUT_TOKEN_ENCRYPTION_KEY: undefined })).toThrow('NIGHTSCOUT_TOKEN_ENCRYPTION_KEY');
    expect(() => validateApiEnvironment({ ...DEVICE_ENV, SETUP_CODE: 'short' })).toThrow('SETUP_CODE must be at least 16 characters');
    expect(() => validateApiEnvironment({ ...DEVICE_ENV, PUBLIC_BASE_URL: 'mellis.example' })).toThrow('PUBLIC_BASE_URL');
  });
});
