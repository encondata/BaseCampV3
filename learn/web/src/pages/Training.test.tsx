// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@portal/auth/AuthContext', () => ({ useAuth: () => ({ status: 'anon', person: null }) }));

import { setLang } from '../lib/i18n';
import { setToken } from '../lib/session';
import Training from './Training';

const LATER = new Date(Date.now() + 3_600_000).toISOString();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const item = (over: Record<string, unknown>) => ({
  assignment_id: 'a-0', title: 'Doc', status: 'assigned', minutes: 4, has_quiz: false,
  locked: false, signed_at: null, ...over,
});

const GROUPS = {
  groups: [{
    initiative: { id: 'i-1', name: 'Acme DFW data center move', start: '2026-11-10' },
    due_on: '2026-11-08',
    items: [
      item({ assignment_id: 'a-1', title: 'Dress code', status: 'signed', signed_at: '2026-11-04T15:00:00Z' }),
      item({ assignment_id: 'a-2', title: 'Acme site rules' }),
      item({ assignment_id: 'a-3', title: 'Acme NDA', minutes: 3, has_quiz: true, locked: true }),
    ],
  }],
  complete: false, badge_uid: null,
};

function renderTraining() {
  return render(
    <MemoryRouter initialEntries={['/training']}>
      <Routes>
        <Route path="/training" element={<Training />} />
        <Route path="/training/:id" element={<p>reader page</p>} />
        <Route path="/done" element={<p>done page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => { sessionStorage.clear(); setToken('tok', LATER, 'Kenji'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setLang('en'); });

describe('Training', () => {
  it('greets the worker and lists the groups with done, next and locked rows', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, GROUPS));
    vi.stubGlobal('fetch', fetchMock);
    renderTraining();
    expect(await screen.findByText('Hi Kenji')).toBeTruthy();
    expect(screen.getByText('Acme DFW data center move')).toBeTruthy();
    expect(screen.getByText(/^1 of 3 done · due \w{3}, Nov 8$/)).toBeTruthy();
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('1');
    expect(bar.getAttribute('aria-valuemax')).toBe('3');

    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    // done: the date it was signed, no link
    expect(within(rows[0]).getByText(/^Signed Nov [34]$/)).toBeTruthy();
    expect(within(rows[0]).queryByRole('link')).toBeNull();
    // next: highlighted, opens the reader
    expect(rows[1].className).toContain('next');
    expect(within(rows[1]).getByText('4 min read')).toBeTruthy();
    expect(within(rows[1]).getByRole('link').getAttribute('href')).toBe('/training/a-2');
    // locked: a lock, no link, and the quiz is flagged
    expect(rows[2].className).toContain('locked');
    expect(within(rows[2]).getByRole('img', { name: 'Locked' })).toBeTruthy();
    expect(within(rows[2]).queryByRole('link')).toBeNull();
    expect(within(rows[2]).getByText('3 min · short quiz')).toBeTruthy();

    expect(screen.getByRole('link', { name: 'Continue: Acme site rules' }).getAttribute('href'))
      .toBe('/training/a-2');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8000/learn/training');
    expect(new Headers(init.headers).get('Authorization')).toBe('Learn tok');
  });

  it('shows the general set under its own heading, without a due date when there is none', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, {
      groups: [{ initiative: null, due_on: null, items: [item({ assignment_id: 'g-1', title: 'Safety' })] }],
      complete: false, badge_uid: null,
    })));
    renderTraining();
    expect(await screen.findByText('General training')).toBeTruthy();
    expect(screen.getByText('0 of 1 done')).toBeTruthy();
  });

  it('says so when nothing is assigned', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, { groups: [], complete: false, badge_uid: null })));
    renderTraining();
    expect(await screen.findByText("You're all caught up.")).toBeTruthy();
    expect(screen.queryByRole('link', { name: /^Continue/ })).toBeNull();
  });

  it('offers the time clock code once everything is signed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, {
      groups: [{ initiative: null, due_on: null, items: [item({ title: 'Safety', status: 'signed', signed_at: '2026-11-04T15:00:00Z' })] }],
      complete: true, badge_uid: 'uid-1',
    })));
    renderTraining();
    const link = await screen.findByRole('link', { name: 'Show my time clock code' });
    expect(link.getAttribute('href')).toBe('/done');
    expect(screen.queryByRole('link', { name: /^Continue/ })).toBeNull();
  });

  it('shows a retry when the list will not load', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    renderTraining();
    expect(await screen.findByText("Couldn't reach the server. Check your connection and try again.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
