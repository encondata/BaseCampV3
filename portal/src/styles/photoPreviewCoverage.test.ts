/**
 * Guardrail: every person's photo in the portal gets the hover preview.
 *
 * Hovering a person's avatar shows a larger, uncropped copy of their photo
 * (components/PhotoPreview.tsx). That only stays true if each new place
 * that draws a person's photo wraps it, so this scans the portal's .tsx
 * source (comments stripped) and fails when:
 *  (a) an `<img>` whose `src` comes from an `avatar_url` / `avatarUrl`
 *      is not inside a `<PhotoPreview>`;
 *  (b) an `<img>` inside one of the person-avatar components
 *      (PERSON_AVATAR_FILES: AvatarUpload and the nav's ChipAvatar,
 *      which receive the url as a prop named `url`) is not inside a
 *      `<PhotoPreview>`;
 *  (c) backstop: a file that mentions `avatar_url` and renders an `<img>`
 *      but contains no `<PhotoPreview` at all (a new person-photo surface
 *      that builds the `<img>` some way the checks above cannot follow);
 *  (d) AvatarUpload stops limiting the preview to `entityType === 'person'`
 *      (it is shared with client and partner logos, which must not get a
 *      "photo" card).
 * Logos (`logo_url`) and non-person images are not person photos and are
 * never matched. A deliberate exception goes in ALLOW below with a reason;
 * an allowlist entry that no longer matches anything fails too, so the
 * list cannot rot.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';

const SRC = join(__dirname, '..');

/** Files whose every `<img>` is a person's photo fed through a `url` prop. */
const PERSON_AVATAR_FILES = ['components/AvatarUpload.tsx', 'layout/AppShell.tsx'];

/** `file` -> reasons. Each entry is the file's path relative to src/. */
const ALLOW: Record<string, string> = {
  // (none: every person-photo <img> is wrapped)
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      walk(p, out);
    } else if (/\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/** Drop block and line comments (a `//` after `:` is part of a URL). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** Index just past the `>` that ends the JSX tag starting at `start`
 *  (braces and quoted strings inside attributes are skipped), and whether
 *  that tag is self-closing (`… />`). */
function tagEnd(text: string, start: number): { end: number; selfClosing: boolean } {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { if (depth > 0 || c === '"') quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (depth === 0 && c === '>' && text[i - 1] !== '=') {
      return { end: i + 1, selfClosing: text[i - 1] === '/' };
    }
  }
  return { end: text.length, selfClosing: false };
}

/** How many `<PhotoPreview>` elements are still open at `index`. A
 *  self-closing `<PhotoPreview … />` never opens anything. */
function openPreviews(text: string, index: number): number {
  const re = /<PhotoPreview\b|<\/PhotoPreview>/g;
  let open = 0;
  for (let m = re.exec(text); m && m.index < index; m = re.exec(text)) {
    if (m[0].startsWith('</')) { open--; continue; }
    const { end, selfClosing } = tagEnd(text, m.index);
    if (!selfClosing && end <= index) open++;
    re.lastIndex = Math.max(re.lastIndex, end);
  }
  return open;
}

interface Img { file: string; line: number; wrapped: boolean; person: boolean }

function scan(): Img[] {
  const found: Img[] = [];
  for (const abs of walk(SRC)) {
    const file = relative(SRC, abs);
    if (file === 'components/PhotoPreview.tsx') continue;   // the card itself
    const text = stripComments(readFileSync(abs, 'utf8'));
    const re = /<img\b[^>]*>/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const tag = m[0];
      const src = /\bsrc=\{([^}]*)\}/.exec(tag)?.[1] ?? '';
      const person = /avatar_?url/i.test(src) || PERSON_AVATAR_FILES.includes(file);
      if (!person) continue;
      found.push({
        file,
        line: text.slice(0, m.index).split('\n').length,
        wrapped: openPreviews(text, m.index) > 0,
        person,
      });
    }
  }
  return found;
}

/** Files that mention `avatar_url`, render an `<img`, and never use
 *  `<PhotoPreview` at all. */
function backstop(): string[] {
  const out: string[] = [];
  for (const abs of walk(SRC)) {
    const file = relative(SRC, abs);
    if (file === 'components/PhotoPreview.tsx') continue;
    const text = stripComments(readFileSync(abs, 'utf8'));
    if (/avatar_?url/i.test(text) && /<img\b/.test(text) && !/<PhotoPreview\b/.test(text)) {
      out.push(file);
    }
  }
  return out;
}

it('the scan finds the portal\'s person photos (it is not matching nothing)', () => {
  const imgs = scan();
  expect(imgs.length).toBeGreaterThanOrEqual(14);
  for (const f of PERSON_AVATAR_FILES) {
    expect(imgs.some((i) => i.file === f), `${f} has no <img> to check`).toBe(true);
  }
});

it('every person-photo <img> is inside a <PhotoPreview>', () => {
  const bad = scan().filter((i) => !i.wrapped && !(i.file in ALLOW));
  expect(
    bad.map((i) => `${i.file}:${i.line}`),
    'wrap the avatar in <PhotoPreview src={…avatar_url} name={…}> (components/PhotoPreview.tsx), '
    + 'or list the file in ALLOW with a reason',
  ).toEqual([]);
});

it('no file shows an avatar_url <img> without using <PhotoPreview> anywhere', () => {
  expect(
    backstop().filter((f) => !(f in ALLOW)),
    'a file mentions avatar_url and renders an <img> but has no <PhotoPreview>: wrap the avatar '
    + '(components/PhotoPreview.tsx), or list the file in ALLOW with a reason',
  ).toEqual([]);
});

it('a self-closing <PhotoPreview /> does not count as wrapping later images', () => {
  const text = '<PhotoPreview src={a} name={b} /><img src={p.avatar_url} />'
    + '<PhotoPreview src={(x) => x > 1 ? a : b} name="n"><img src={q.avatar_url} /></PhotoPreview>'
    + '<img src={r.avatar_url} />';
  const at = (needle: string) => text.indexOf(needle);
  expect(openPreviews(text, at('<img src={p.'))).toBe(0);
  expect(openPreviews(text, at('<img src={q.'))).toBe(1);
  expect(openPreviews(text, at('<img src={r.'))).toBe(0);
});

it('every ALLOW entry still excuses a real, unwrapped person photo', () => {
  const unwrapped = new Set([
    ...scan().filter((i) => !i.wrapped).map((i) => i.file),
    ...backstop(),
  ]);
  const stale = Object.keys(ALLOW).filter((f) => !unwrapped.has(f));
  expect(stale).toEqual([]);
});

it('AvatarUpload limits the preview to person photos', () => {
  const text = stripComments(readFileSync(join(SRC, 'components/AvatarUpload.tsx'), 'utf8'));
  expect(text).toMatch(/<PhotoPreview\s+src=\{entityType === 'person' \? url : null\}/);
});
