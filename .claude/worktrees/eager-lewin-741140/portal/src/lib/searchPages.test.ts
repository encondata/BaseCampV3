import { describe, expect, it } from 'vitest';
import { SEARCH_PAGES, searchPages } from './searchPages';

const canAll = () => true;
const canNone = () => false;
const canAllBut = (denied: string) => (resource: string) => resource !== denied;

const labels = (pages: { label: string }[]) => pages.map((p) => p.label);

describe('searchPages', () => {
  it('drops a page whose resource the user cannot view', () => {
    expect(labels(searchPages('sett', canAll, false))).toEqual(['Settings']);
    expect(searchPages('sett', canAllBut('settings'), false)).toEqual([]);
  });

  // The leak this guards: a plain substring match over the page table, with no
  // permission check, surfaced every page name to every user.
  it('gates every resource-backed page, not just Settings', () => {
    for (const page of SEARCH_PAGES) {
      if (page.resource === null) continue;
      expect(
        labels(searchPages(page.label, canAllBut(page.resource), false)),
        `${page.label} leaks to a user without ${page.resource}:view`,
      ).not.toContain(page.label);
    }
  });

  it('keeps a page with no resource — /me has no ProtectedRoute to mirror', () => {
    expect(labels(searchPages('profile', canNone, false))).toEqual(['My profile']);
  });

  it('never surfaces the godOnly dev pages, god mode or not', () => {
    for (const godMode of [false, true]) {
      expect(searchPages('developer', canAll, godMode)).toEqual([]);
      expect(searchPages('variables', canAll, godMode)).toEqual([]);
    }
  });

  it('matches case-insensitively on any substring of the label', () => {
    expect(labels(searchPages('  WORK ', canAll, false))).toEqual(['Workers']);
  });

  it('offers nothing until something is typed', () => {
    expect(searchPages('', canAll, false)).toEqual([]);
    expect(searchPages('   ', canAll, false)).toEqual([]);
  });
});
