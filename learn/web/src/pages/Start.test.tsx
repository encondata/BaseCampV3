// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getToken } from '../lib/session';
import Start from './Start';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{`${loc.pathname}${loc.hash}`}</p>;
}

function renderAt(hash: string) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/start', hash }]}>
      <Routes>
        <Route path="/start" element={<><Start /><Where /></>} />
        <Route path="/training" element={<><p>training page</p><Where /></>} />
        <Route path="/" element={<p>sign-in page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => { sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Start (the invite link)', () => {
  it('signs in with the link token, drops it from the address and opens the training', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, {
      token: 'learn-tok', expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      person: { first_name: 'Kenji' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    renderAt('#t=link-abc_123');
    expect(await screen.findByText('training page')).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe('/training');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8000/learn/auth/link');
    expect(JSON.parse(String(init.body))).toEqual({ token: 'link-abc_123' });
    expect(getToken()).toBe('learn-tok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('takes the token out of the address before the server answers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    renderAt('#t=link-abc');
    expect(await screen.findByText('Signing you in…')).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe('/start');
  });

  it('explains a link that no longer works and offers the code form', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(401, { detail: { code: 'learn_code_invalid' } })));
    renderAt('#t=old');
    expect(await screen.findByText(
      "This link doesn't work anymore. Sign in with the code from your invite email.")).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Enter your code' }).getAttribute('href')).toBe('/');
    expect(getToken()).toBeNull();
  });

  it('goes straight to the code form when there is no token', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderAt('');
    expect(await screen.findByText('sign-in page')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
