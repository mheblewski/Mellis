export interface ApiListenOptions {
  port: number;
  /** undefined: listen on every interface (needed for a physical iPhone on the LAN). */
  host?: string;
}

export const DEFAULT_API_PORT = 3000;

/**
 * API_PORT: unset or empty listens on 3000 (an empty value used to mean port 0, a random port); otherwise a whole
 * number 0-65535, anything else stops the start with a clear error. API_HOST is optional: unset or empty keeps the
 * previous behaviour of listening on every interface; a value such as 127.0.0.1 restricts the API to that address
 * (local testing with auth disabled).
 */
export function resolveApiListenOptions(env: NodeJS.ProcessEnv): ApiListenOptions {
  const port = parseApiPort(env.API_PORT);
  const host = env.API_HOST?.trim();
  if (!host) {
    return { port };
  }
  if (/\s/.test(host)) {
    throw new Error('Invalid environment variable: API_HOST must be a single host name or address');
  }
  return { port, host };
}

function parseApiPort(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) {
    return DEFAULT_API_PORT;
  }
  const port = Number(value);
  if (!/^\d+$/.test(value) || port > 65535) {
    throw new Error('Invalid environment variable: API_PORT must be a port number (0-65535)');
  }
  return port;
}
