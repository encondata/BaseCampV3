// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setToken } from './session';
import { getAssignment, getQuiz, signAssignment, submitQuiz } from './training';

const urls = () => (fetch as ReturnType<typeof vi.fn>).mock.calls.map(([u]) => String(u));

beforeEach(() => {
  sessionStorage.clear();
  setToken('tok', new Date(Date.now() + 3_600_000).toISOString());
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});
afterEach(() => vi.unstubAllGlobals());

describe('training paths', () => {
  it('puts an id in the path as one encoded segment, whatever it holds', async () => {
    const evil = '../../auth/logout?x=1#y';
    await getAssignment(evil, 'en');
    await getQuiz(evil, 'en');
    await submitQuiz(evil, {});
    await signAssignment(evil, { agreed: true, language: 'en', scrolled_to_end: true });
    const enc = encodeURIComponent(evil);
    expect(urls()).toEqual([
      `http://localhost:8000/learn/assignments/${enc}?lang=en`,
      `http://localhost:8000/learn/assignments/${enc}/quiz?lang=en`,
      `http://localhost:8000/learn/assignments/${enc}/quiz`,
      `http://localhost:8000/learn/assignments/${enc}/sign`,
    ]);
    for (const u of urls()) expect(u).not.toContain('/auth/');
  });
});
