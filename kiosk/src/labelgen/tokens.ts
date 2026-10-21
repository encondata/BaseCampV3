/**
 * Placeholder tokens (labels/tokens.py): exactly `{key}` with keys
 * ^[a-z0-9_]+$. Unknown tokens resolve to '' at substitution time.
 *
 * Pure: no DOM, no Intl, no Node.
 */

/** Global: use it with `replace`/`matchAll`, never `test`/`exec`, which keep
 *  state between calls. */
export const TOKEN_RE = /\{([a-z0-9_]+)\}/g;

const own = (values: Readonly<Record<string, string>>, key: string): string => (
  Object.prototype.hasOwnProperty.call(values, key) ? values[key] : ''
);

/** null = leave tokens intact (storage form); a record = substitute. */
export function resolveTokens(value: string, subs: Readonly<Record<string, string>> | null): string {
  if (subs === null) return value;
  return value.replace(TOKEN_RE, (_, key: string) => own(subs, key));
}

/** Raw-code templates: substitute every token; unknown -> ''. */
export function applyPlaceholders(code: string, values: Readonly<Record<string, string>>): string {
  return code.replace(TOKEN_RE, (_, key: string) => own(values, key));
}
