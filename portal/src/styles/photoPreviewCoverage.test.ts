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
 *  (c) AvatarUpload stops limiting the preview to `entityType === 'person'`
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
      const before = text.slice(0, m.index);
      const opens = (before.match(/<PhotoPreview\b/g) ?? []).length;
      const closes = (before.match(/<\/PhotoPreview>/g) ?? []).length;
      found.push({
        file,
        line: before.split('\n').length,
        wrapped: opens > closes,
        person,
      });
    }
  }
  return found;
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

it('every ALLOW entry still excuses a real, unwrapped person photo', () => {
  const unwrapped = new Set(scan().filter((i) => !i.wrapped).map((i) => i.file));
  const stale = Object.keys(ALLOW).filter((f) => !unwrapped.has(f));
  expect(stale).toEqual([]);
});

it('AvatarUpload limits the preview to person photos', () => {
  const text = stripComments(readFileSync(join(SRC, 'components/AvatarUpload.tsx'), 'utf8'));
  expect(text).toMatch(/<PhotoPreview\s+src=\{entityType === 'person' \? url : null\}/);
});
