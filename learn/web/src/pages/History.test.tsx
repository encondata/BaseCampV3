// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@portal/auth/AuthContext', () => ({ useAuth: () => ({ status: 'anon', person: null }) }));

import { setLang } from '../lib/i18n';
import { setToken } from '../lib/session';
import History from './History';

const LATER = new Date(Date.now() + 3_600_000).toISOString();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const row = (n: number, over: Record<string, unknown> = {}) => ({
  assignment_id: `h-${n}`, title: `Doc ${n}`, version_no: 1, initiative: null,
  signed_at: '2026-11-04T15:00:00Z', language: 'en', newer_version: false, ...over,
});

function renderHistory(items: unknown[]) {
  const fetchMock = vi.fn().mockResolvedValue(json(200, items));
  vi.stubGlobal('fetch', fetchMock);
  render(
    <MemoryRouter initialEntries={['/history']}>
      <Routes>
        <Route path="/history" element={<History />} />
        <Route path="/training" element={<p>training page</p>} />
        <Route path="/training/:id" element={<p>reader page</p>} />
      </Routes>
    </MemoryRouter>,
  );
  return fetchMock;
}

beforeEach(() => { sessionStorage.clear(); setToken('tok', LATER, 'Kenji'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setLang('en'); });

describe('History', () => {
  it('lists the sign-offs as returned, newest first, each linking to its document', async () => {
    const fetchMock = renderHistory([
      row(1, { title: 'Acme site rules', version_no: 2, initiative: { id: 'i-1', name: 'Acme DFW data center move' }, newer_version: true }),
      row(2, { title: 'Dress code' }),
    ]);
    expect(await screen.findByRole('heading', { name: 'Completed training' })).toBeTruthy();
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('Acme site rules')).toBeTruthy();
    expect(within(rows[0]).getByText(/^Signed Nov [34] · v2 · Acme DFW data center move · Updated since$/)).toBeTruthy();
    expect(within(rows[0]).getByRole('link').getAttribute('href')).toBe('/training/h-1');
    expect(within(rows[1]).getByText('Dress code')).toBeTruthy();
    // a null initiative is the general set; no "updated" tag when nothing newer
    expect(within(rows[1]).getByText(/^Signed Nov [34] · v1 · General training$/)).toBeTruthy();
    expect(within(rows[1]).getByRole('link').getAttribute('href')).toBe('/training/h-2');
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://localhost:8000/learn/history');
  });

  it('says so when nothing is signed yet', async () => {
    renderHistory([]);
    expect(await screen.findByText('Nothing signed yet.')).toBeTruthy();
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('links back to the training list', async () => {
    renderHistory([row(1)]);
    await screen.findByText('Doc 1');
    expect(screen.getByRole('link', { name: 'Back' }).getAttribute('href')).toBe('/training');
  });
});
