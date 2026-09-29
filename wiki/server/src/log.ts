/** One-line JSON logs for the wiki server. Never pass a token in `fields`. */
type LogLevel = 'info' | 'error';

export function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}

/** An error as something safe to log: its message (an ApiError's names the
 *  status and code), never the request that caused it. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
