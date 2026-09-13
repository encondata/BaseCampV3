/** Guard before rendering any stored URL (organization website, etc.) as an
 *  `<a href>` — the API normalizes/validates on write (security-fixes task
 *  7), but this is the independent, render-time guard: even a URL that
 *  reached storage some other way (an older row, a direct DB edit) can
 *  never execute as `javascript:`/`data:` in the portal's origin. Returns
 *  the URL unchanged when it's safe to link, or null when the caller should
 *  render it as plain text instead. */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? trimmed : null;
}
