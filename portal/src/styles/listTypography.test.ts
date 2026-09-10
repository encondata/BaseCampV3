/**
 * Guardrail: list typography lives ONLY in directory.css, as tokens.
 * (a) no other stylesheet sets font-size/font-family/font-weight/
 *     line-height/min-height on a list-ish selector;
 * (b) no page/component renders a raw <table> (use <DataTable>);
 * (c) directory.css list rules use var(--list-…) tokens, never literal px,
 *     for those properties.
 * Deliberate exceptions live in listTypography.allow.json with a reason.
 * Violations print a ready-to-paste allowlist snippet — but the fix is
 * almost always to use the tokens/primitives, not to allowlist.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
const LIST_SELECTOR = /(row|cell|list|table|chip|mono|\bpn\b|\bps\b|head)/i;
const TYPO_PROPS = /^(font-size|font-family|font-weight|line-height|min-height)\s*:/;
const DIRECTORY_LIST_RULE = /\.(dir-list|list-head|dir-row|row-main|cell|chip|kv|mini-|data-table)/;

interface Allow { file: string; selector?: string; reason: string; }
const allow: Allow[] = JSON.parse(
  readFileSync(join(__dirname, 'listTypography.allow.json'), 'utf8'));
const allowed = (file: string, selector?: string) =>
  allow.some((a) => a.file === file && (a.selector === undefined || a.selector === selector));

function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (ext.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Flat (selector, declarations[]) pairs; nested @media wrappers are
 *  consumed innermost-first by the regex, leaving empty wrappers. */
function rules(css: string): { selector: string; decls: string[] }[] {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: { selector: string; decls: string[] }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noComments)) !== null) {
    const selector = m[1].trim().replace(/\s+/g, ' ');
    if (selector.startsWith('@')) continue;
    const decls = m[2].split(';').map((d) => d.trim()).filter(Boolean);
    out.push({ selector, decls });
  }
  return out;
}

const rel = (p: string) => relative(SRC, p).replace(/\\/g, '/');
const snippet = (items: Allow[]) => JSON.stringify(items, null, 2);

describe('list typography guardrail', () => {
  it('(a) only directory.css sets typography on list-ish selectors', () => {
    const bad: Allow[] = [];
    for (const file of walk(join(SRC, 'styles'), /\.css$/)) {
      const f = rel(file);
      if (f === 'styles/directory.css') continue;
      for (const r of rules(readFileSync(file, 'utf8'))) {
        if (!LIST_SELECTOR.test(r.selector)) continue;
        if (!r.decls.some((d) => TYPO_PROPS.test(d))) continue;
        if (!allowed(f, r.selector)) bad.push({ file: f, selector: r.selector, reason: '' });
      }
    }
    expect(bad, `list typography outside directory.css:\n${snippet(bad)}`).toEqual([]);
  });

  it('(b) no raw <table> outside components/DataTable.tsx', () => {
    const bad: Allow[] = [];
    for (const dir of ['pages', 'components']) {
      for (const file of walk(join(SRC, dir), /\.tsx$/)) {
        const f = rel(file);
        if (f === 'components/DataTable.tsx') continue;
        if (/<table\b/.test(readFileSync(file, 'utf8')) && !allowed(f)) {
          bad.push({ file: f, reason: '' });
        }
      }
    }
    expect(bad, `raw <table> (use <DataTable>):\n${snippet(bad)}`).toEqual([]);
  });

  it('(c) directory.css list rules use tokens, not literal px, for typography', () => {
    const bad: string[] = [];
    for (const r of rules(readFileSync(join(SRC, 'styles/directory.css'), 'utf8'))) {
      if (!DIRECTORY_LIST_RULE.test(r.selector)) continue;
      for (const d of r.decls) {
        if (TYPO_PROPS.test(d) && /\d(px|pt)\b/.test(d) && !/var\(--list-/.test(d)
            && !allowed('styles/directory.css', r.selector)) {
          bad.push(`${r.selector} { ${d} }`);
        }
      }
    }
    expect(bad, `literal sizes in directory.css list rules:\n${bad.join('\n')}`).toEqual([]);
  });

  it('every allowlist entry carries a reason', () => {
    expect(allow.filter((a) => !a.reason.trim())).toEqual([]);
  });
});
