/**
 * Every /dev/matching-rules… route is a Developer page: it must sit behind
 * ProtectedRoute resource="devtools", and the route table that mirrors the
 * API's access model must say so too. Reads App.tsx as text, so a route
 * added later (the editor, Task 10) is covered without rendering the app.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { ROUTE_RESOURCE } from './lib/access';

const app = readFileSync(join(__dirname, 'App.tsx'), 'utf8');

/** Each `<Route path="/dev/matching-rules…"` element, up to the next Route. */
function matchingRoutes(): string[] {
  const out: string[] = [];
  const re = /<Route\s+path="\/dev\/matching-rules[^"]*"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(app)) !== null) {
    const rest = app.slice(m.index + m[0].length);
    const end = rest.search(/<Route\s|<\/Route>/);
    out.push(m[0] + (end === -1 ? rest : rest.slice(0, end)));
  }
  return out;
}

it('every /dev/matching-rules route is guarded by devtools', () => {
  const routes = matchingRoutes();
  expect(routes.length).toBeGreaterThan(0);
  for (const r of routes) expect(r, r).toContain('ProtectedRoute resource="devtools"');
});

it('the route table maps /dev/matching-rules to devtools', () => {
  expect(ROUTE_RESOURCE['/dev/matching-rules']).toBe('devtools');
});
