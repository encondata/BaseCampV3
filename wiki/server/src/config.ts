/** The wiki server's settings, from the environment. */
export interface ServerConfig {
  /** HTTP port (PORT, default 5177). */
  port: number;
  /** The main API's origin, no trailing slash (WIKI_API_URL). */
  apiUrl: string;
  /** Shared with the API as SS_WIKI_SERVICE_TOKEN (WIKI_SERVICE_TOKEN).
   *  Empty turns live editing and /internal/render off; the SPA and
   *  /healthz still work. */
  serviceToken: string;
  /** The built SPA (WIKI_STATIC_DIR, default `dist`, relative to the
   *  working directory). */
  staticDir: string;
  /** How often open connections are re-authorized (WIKI_REAUTH_MS). */
  reauthMs: number;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive whole number (got ${JSON.stringify(raw)})`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: positiveInt(env, 'PORT', 5177),
    apiUrl: (env.WIKI_API_URL || 'http://localhost:8000').replace(/\/+$/, ''),
    serviceToken: env.WIKI_SERVICE_TOKEN ?? '',
    staticDir: env.WIKI_STATIC_DIR || 'dist',
    reauthMs: positiveInt(env, 'WIKI_REAUTH_MS', 300_000),
  };
}
