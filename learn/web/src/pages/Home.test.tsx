// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ value: { status: 'anon', person: null } as { status: string; person: Record<string, unknown> | null } }));
vi.mock('@portal/auth/AuthContext', () => ({ useAuth: () => auth.value }));

import { setLang } from '../lib/i18n';
import { setToken } from '../lib/session';
import Home from './Home';

const LATER = new Date(Date.now() + 3_600_000).toISOString();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const item = (over: Record<string, unknown>) => ({
  assignment_id: 'a-0', title: 'Doc', status: 'assigned', minutes: 4, has_quiz: false,
  locked: false, signed_at: null, ...over,
});

const hist = (n: number, over: Record<string, unknown> = {}) => ({
  assignment_id: `h-${n}`, title: `Signed doc ${n}`, version_no: 1, initiative: null,
  signed_at: '2026-11-04T15:00:00Z', language: 'en', newer_version: false, ...over,
});

const EMPTY = { groups: [], complete: false, badge_uid: null };

/** Answers /learn/history with `history` (a Response for a failure) and everything else with `training`. */
function api(training: unknown, history: unknown[] | Response = []) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith('/learn/history')) return history instanceof Response ? history : json(200, history);
    return json(200, training);
  }));
}

function renderHome() {
  return render(
    <MemoryRouter initialEntries={['/home']}>
      <Routes>
        <Route path="/home" element={<Home />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** The value and sub line of a KPI tile, found by its label. */
function tile(label: string) {
  const el = screen.getByText(label).closest('.dash-kpi') as HTMLElement;
  return {
    value: el.querySelector('.dash-kpi-value')?.textContent,
    sub: el.querySelector('.dash-kpi-sub')?.textContent,
  };
}

function panel(title: string) {
  return within(screen.getByText(title).closest('.dash-panel') as HTMLElement);
}

beforeEach(() => { sessionStorage.clear(); auth.value = { status: 'anon', person: null }; setToken('tok', LATER, 'Wanda'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setLang('en'); });

const OPEN = {
  groups: [
    {
      initiative: { id: 'i-1', name: 'Acme move', start: '2026-11-10' }, due_on: '2026-11-08',
      items: [item({ assignment_id: 'a-1', title: 'Acme site rules' })],
    },
    { initiative: null, due_on: null, items: [item({ assignment_id: 'a-2', title: 'Dress code' })] },
  ],
  complete: false, badge_uid: null,
};

describe('Home', () => {
  it('shows the caught-up state with empty tiles and panels', async () => {
    api(EMPTY);
    renderHome();
    expect(await screen.findByText('Welcome back, Wanda')).toBeTruthy();
    expect(screen.getByText("You're all caught up.")).toBeTruthy();
    expect(tile('To sign')).toEqual({ value: '0', sub: 'Nothing due' });
    expect(tile('Completed')).toEqual({ value: '0', sub: 'None yet' });
    expect(tile('Moves')).toEqual({ value: '0', sub: 'None assigned' });
    const up = panel('Up next');
    expect(up.getByText('Nothing to sign right now.')).toBeTruthy();
    expect(up.getByText('New training shows up here as soon as it is assigned to you.')).toBeTruthy();
    const recent = panel('Recently completed');
    expect(recent.getByText('Your signed training will appear here.')).toBeTruthy();
    expect(recent.getByText('Every document you sign stays here so you can reopen it any time.')).toBeTruthy();
    expect(screen.queryByText(/^Continue/)).toBeNull();
    expect(screen.queryByText('Show my code')).toBeNull();
  });

  it('greets without a name when the session has none', async () => {
    setToken('tok', LATER, '');
    api(EMPTY);
    renderHome();
    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome back' })).toBeTruthy();
  });

  it('counts what is open, lists it as links and shows the newest five completed', async () => {
    api(OPEN, [1, 2, 3, 4, 5, 6, 7].map((n) => hist(n)));
    renderHome();
    expect(await screen.findByText('2 to sign')).toBeTruthy();
    expect(tile('To sign')).toEqual({ value: '2', sub: 'Next due Sun, Nov 8' });
    expect(await screen.findByText('Last signed Nov 4')).toBeTruthy();
    expect(tile('Completed').value).toBe('7');
    expect(tile('Moves').value).toBe('1');

    const up = panel('Up next');
    expect(up.getByRole('link', { name: /^Acme site rules/ }).getAttribute('href')).toBe('/training/a-1');
    expect(up.getByRole('link', { name: /^Dress code/ }).getAttribute('href')).toBe('/training/a-2');
    expect(screen.getByRole('link', { name: 'Continue: Acme site rules' }).getAttribute('href')).toBe('/training/a-1');
    expect(up.getByRole('link', { name: 'My training' }).getAttribute('href')).toBe('/training');

    const recent = panel('Recently completed');
    expect(recent.getAllByRole('listitem')).toHaveLength(5);
    expect(recent.getByRole('link', { name: 'View all (7)' }).getAttribute('href')).toBe('/history');
  });

  it('says "General training only" when only general items exist', async () => {
    api({ groups: [OPEN.groups[1]], complete: false, badge_uid: null });
    renderHome();
    expect(await screen.findByText('1 to sign')).toBeTruthy();
    expect(tile('Moves')).toEqual({ value: '0', sub: 'General training only' });
    expect(tile('To sign').sub).toBe('Nothing due');
  });

  it('counts locked items to sign but neither lists nor offers them', async () => {
    api({
      groups: [{
        initiative: null, due_on: null,
        items: [
          item({ assignment_id: 'a-1', title: 'Locked quiz doc', locked: true, has_quiz: true }),
          item({ assignment_id: 'a-2', title: 'Open doc' }),
          item({ assignment_id: 'a-3', title: 'Signed doc', status: 'signed', signed_at: '2026-11-04T15:00:00Z' }),
        ],
      }],
      complete: false, badge_uid: null,
    });
    renderHome();
    expect(await screen.findByText('2 to sign')).toBeTruthy();
    expect(tile('To sign').value).toBe('2');
    const up = panel('Up next');
    expect(up.getAllByRole('listitem')).toHaveLength(1);
    expect(up.queryByText('Locked quiz doc')).toBeNull();
    expect(screen.getByRole('link', { name: 'Continue: Open doc' })).toBeTruthy();
  });

  it('takes "next due" from groups that still have an open item', async () => {
    api({
      groups: [
        { initiative: { id: 'i-1', name: 'Done move', start: null }, due_on: '2026-11-01',
          items: [item({ assignment_id: 'a-1', status: 'signed', signed_at: '2026-10-30T15:00:00Z' })] },
        { initiative: { id: 'i-2', name: 'Late move', start: null }, due_on: '2026-11-20',
          items: [item({ assignment_id: 'a-2', title: 'Late doc' })] },
        { initiative: { id: 'i-3', name: 'Soon move', start: null }, due_on: '2026-11-12',
          items: [item({ assignment_id: 'a-3', title: 'Soon doc' })] },
      ],
      complete: false, badge_uid: null,
    });
    renderHome();
    expect(await screen.findByText('2 to sign')).toBeTruthy();
    expect(tile('To sign').sub).toBe('Next due Thu, Nov 12');
  });

  it('lists at most five open documents', async () => {
    api({
      groups: [{ initiative: null, due_on: null,
        items: [1, 2, 3, 4, 5, 6, 7].map((n) => item({ assignment_id: `a-${n}`, title: `Doc ${n}` })) }],
      complete: false, badge_uid: null,
    });
    renderHome();
    expect(await screen.findByText('7 to sign')).toBeTruthy();
    expect(tile('To sign').value).toBe('7');
    expect(panel('Up next').getAllByRole('listitem')).toHaveLength(5);
  });

  it('survives a failed history load: dash tile, empty panel', async () => {
    api(OPEN, json(500, { detail: { code: 'boom' } }));
    renderHome();
    expect(await screen.findByText('2 to sign')).toBeTruthy();
    expect(await screen.findByText('Your signed training will appear here.')).toBeTruthy();
    expect(tile('Completed').value).toBe('—');
  });

  it('offers the time clock code once everything is signed', async () => {
    api({ groups: [], complete: true, badge_uid: 'B1' });
    renderHome();
    expect(await screen.findByText('Your training is complete. Show your time clock code at the station.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Show my code' }).getAttribute('href')).toBe('/done');
  });

  it('shows the loading line, then a retry when training fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(500, { detail: { code: 'boom' } })));
    renderHome();
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
