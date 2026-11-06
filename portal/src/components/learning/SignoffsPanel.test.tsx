// @vitest-environment jsdom
/** The Sign-offs tab's Read time cell: the time, plus the slides viewed for a Slides sign-off. */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ can: () => true, scope: { global: true }, preferences: {}, updatePreferences: vi.fn() }),
}));

const api = vi.hoisted(() => ({ listDocumentSignoffs: vi.fn() }));
vi.mock('../../lib/learning', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/learning')>()), ...api,
}));

const { default: SignoffsPanel } = await import('./SignoffsPanel');

const row = (id: string, name: string, readSeconds: number, slidesViewed: number | null) => ({
  id, person: { id: `p-${id}`, name }, version_no: 2, language: 'en',
  signed_at: '2026-10-20T15:00:00Z', read_seconds: readSeconds, slides_viewed: slidesViewed,
  quiz_score: null, initiative_id: null, initiative: null,
});

beforeEach(() => {
  api.listDocumentSignoffs.mockReset().mockResolvedValue({
    total: 2, version_counts: {},
    items: [row('s1', 'Slide Reader', 60, 4), row('s2', 'Page Reader', 75, null)],
  });
});
afterEach(cleanup);

it('shows slides viewed next to the reading time', async () => {
  render(<SignoffsPanel documentId="d1" versions={[]} />);
  await screen.findByText('Slide Reader');
  expect(screen.getByText('1 min · 4 slides')).toBeTruthy();
  // a Document-style sign-off shows the time alone
  expect(screen.getByText('1 min 15 s')).toBeTruthy();
});
