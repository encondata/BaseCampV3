// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  value: { status: 'anon', person: null, logout: async () => {} } as {
    status: string; person: Record<string, unknown> | null; logout: () => Promise<void>;
  },
}));
vi.mock('@portal/auth/AuthContext', () => ({ useAuth: () => auth.value }));
vi.mock('@portal/pages/Login', () => ({ default: () => <p>portal sign-in</p> }));

import App from '../App';
import { getLang, setLang, setOffered } from '../lib/i18n';
import { setToken, TOKEN_KEY } from '../lib/session';
import LearnShell from './LearnShell';

const LATER = new Date(Date.now() + 3_600_000).toISOString();
const OPEN = { groups: [], complete: false, badge_uid: null };
const COMPLETE = { groups: [], complete: true, badge_uid: 'B1' };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** /learn/training answers with each of `trainings` in turn (the last one
 *  from then on; a Response or a pending promise is returned as is),
 *  /learn/history with [], sign-out and languages with 200. */
function api(...trainings: unknown[]) {
  let calls = 0;
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith('/learn/training')) {
      const next = trainings[Math.min(calls++, trainings.length - 1)];
      return next instanceof Response || next instanceof Promise ? next : json(200, next);
    }
    if (url.endsWith('/learn/history')) return json(200, []);
    if (url.endsWith('/learn/languages')) return json(200, [{ code: 'en', rtl: false }]);
    if (url.endsWith('/learn/auth/logout')) return json(200, {});
    return json(404, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderShell(at: string) {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route element={<LearnShell />}>
          <Route path="/home" element={<p>home page</p>} />
          <Route path="/training" element={<p>training page</p>} />
          <Route path="/training/:id" element={<Link to="/training">finish reading</Link>} />
          <Route path="/history" element={<p>history page</p>} />
          <Route path="/done" element={<p>done page</p>} />
        </Route>
        <Route path="/" element={<p>sign-in page</p>} />
      </Routes>
      <Where />
    </MemoryRouter>,
  );
}

function stubViewport(mobile: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: mobile && query === '(max-width: 900px)', media: query,
    addEventListener: () => {}, removeEventListener: () => {},
  }));
}

/** Lets the training and history loads settle. */
async function settle(fetchMock: ReturnType<typeof api>) {
  await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u.endsWith('/learn/training'))).toBe(true));
  await act(async () => {});
}

const nav = () => screen.getByRole('navigation', { name: 'Primary' });

beforeEach(() => {
  sessionStorage.clear();
  auth.value = { status: 'anon', person: null, logout: async () => {} };
  stubViewport(false);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setLang('en');
  localStorage.clear();
  setOffered([{ code: 'en', rtl: false }]);
});

describe('LearnShell', () => {
  it('shows the nav with its Learning tag and pages, and no time clock code until training is complete', async () => {
    setToken('tok', LATER, 'Wanda');
    const fetchMock = api(OPEN);
    const { container } = renderShell('/home');
    expect(screen.getByText('home page')).toBeTruthy();
    expect(container.querySelector('.portal-nav .logo-tag')?.textContent).toBe('Learning');
    const links = within(nav()).getAllByRole('link');
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Home', '/home'], ['My training', '/training'], ['Completed training', '/history'],
    ]);
    await settle(fetchMock);
    expect(within(nav()).queryByRole('link', { name: 'Time clock code' })).toBeNull();
  });

  it('adds the time clock code once training is complete with a badge', async () => {
    setToken('tok', LATER, 'Wanda');
    api(COMPLETE);
    renderShell('/home');
    const link = await within(nav()).findByRole('link', { name: 'Time clock code' });
    expect(link.getAttribute('href')).toBe('/done');
  });

  it('loads again on leaving a document, so a last sign-off brings up the time clock code', async () => {
    setToken('tok', LATER, 'Wanda');
    const fetchMock = api(OPEN, COMPLETE);
    renderShell('/training/a-1');
    await settle(fetchMock);
    expect(within(nav()).queryByRole('link', { name: 'Time clock code' })).toBeNull();
    await userEvent.click(screen.getByRole('link', { name: 'finish reading' }));
    expect(await within(nav()).findByRole('link', { name: 'Time clock code' })).toBeTruthy();
  });

  it.each([
    ['while the reload is in flight', new Promise<Response>(() => {})],
    ['when the reload fails', json(500, { detail: { code: 'boom' } })],
  ])('keeps the time clock code %s after leaving a document', async (_when, reloaded) => {
    setToken('tok', LATER, 'Wanda');
    const fetchMock = api(COMPLETE, reloaded);
    renderShell('/training/a-1');
    expect(await within(nav()).findByRole('link', { name: 'Time clock code' })).toBeTruthy();
    await userEvent.click(screen.getByRole('link', { name: 'finish reading' }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([u]) => u.endsWith('/learn/training'))).toHaveLength(2));
    await act(async () => {});
    expect(within(nav()).getByRole('link', { name: 'Time clock code' })).toBeTruthy();
  });

  it('crumbs read Learning, then the page on screen', async () => {
    setToken('tok', LATER, 'Wanda');
    api(OPEN);
    const crumbs = (container: HTMLElement) => container.querySelector('.topbar .crumbs') as HTMLElement;
    const first = renderShell('/history');
    expect(within(crumbs(first.container)).getByText('Learning')).toBeTruthy();
    expect(crumbs(first.container).querySelector('b')?.textContent).toBe('Completed training');
    first.unmount();

    // a document (and its quiz) sits under My training
    const doc = renderShell('/training/a-1');
    expect(crumbs(doc.container).querySelector('b')?.textContent).toBe('My training');
  });

  it('a code session: the chip names the worker, and Sign out drops the token', async () => {
    setToken('tok', LATER, 'Wanda');
    api(OPEN);
    renderShell('/home');
    const chip = within(nav()).getByRole('button', { name: /Wanda/ });
    expect(within(chip).getByText('Wanda')).toBeTruthy();
    expect(within(chip).getByText('Learning code')).toBeTruthy();
    await userEvent.click(chip);
    expect(screen.queryByRole('menuitem', { name: 'Back to portal' })).toBeNull();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(screen.getByTestId('where').textContent).toBe('/');
  });

  it('a code session without a first name says "Learning code" on the chip', () => {
    setToken('tok', LATER);
    api(OPEN);
    renderShell('/home');
    const chip = within(nav()).getByRole('button', { name: /Learning code/ });
    expect(chip.querySelector('.user-name')?.textContent).toBe('Learning code');
  });

  it('the user menu closes on an outside click and on Escape', async () => {
    setToken('tok', LATER, 'Wanda');
    api(OPEN);
    renderShell('/home');
    const chip = within(nav()).getByRole('button', { name: /Wanda/ });
    await userEvent.click(chip);
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toBeTruthy();
    await userEvent.click(screen.getByText('home page'));
    expect(screen.queryByRole('menuitem', { name: 'Sign out' })).toBeNull();

    await userEvent.click(chip);
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menuitem', { name: 'Sign out' })).toBeNull();
  });

  it('an account: the chip names the person, and the menu goes back to the portal or signs out', async () => {
    const logout = vi.fn(async () => {});
    auth.value = {
      status: 'authed',
      person: { id: 'p-1', first_name: 'Ana', last_name: 'Ruiz', display_name: 'Ana Ruiz', email: 'ana@example.com', avatar_url: null },
      logout,
    };
    api(OPEN);
    renderShell('/home');
    const chip = within(nav()).getByRole('button', { name: /Ana Ruiz/ });
    expect(within(chip).getByText('Account')).toBeTruthy();
    await userEvent.click(chip);
    const back = screen.getByRole('menuitem', { name: 'Back to portal' });
    expect(back.getAttribute('href')).toBe('http://localhost:5173');
    await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(logout).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('where').textContent).toBe('/');
  });

  it('on a phone the nav hides behind a hamburger that opens it as an overlay', async () => {
    stubViewport(true);
    setToken('tok', LATER, 'Wanda');
    api(OPEN);
    const { container } = renderShell('/home');
    expect(screen.queryByRole('link', { name: 'My training' })).toBeNull();
    expect(container.querySelector('.portal-nav.overlay')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    const overlay = container.querySelector('.portal-nav.overlay') as HTMLElement;
    expect(overlay).toBeTruthy();
    // following a link closes it
    await userEvent.click(within(overlay).getByRole('link', { name: 'Completed training' }));
    expect(screen.getByTestId('where').textContent).toBe('/history');
    expect(container.querySelector('.portal-nav.overlay')).toBeNull();

    // and so does Escape
    await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(container.querySelector('.portal-nav.overlay')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(container.querySelector('.portal-nav.overlay')).toBeNull();

    // and so does a click on the scrim
    await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    await userEvent.click(container.querySelector('.nav-overlay-scrim') as HTMLElement);
    expect(container.querySelector('.portal-nav.overlay')).toBeNull();
  });

  it('the language menu shows only with two or more languages, and switches the language', async () => {
    setToken('tok', LATER, 'Wanda');
    api(OPEN);
    const { unmount } = renderShell('/home');
    expect(screen.queryByRole('button', { name: 'Language' })).toBeNull();
    unmount();

    setOffered([{ code: 'en', rtl: false }, { code: 'ja', rtl: false }]);
    renderShell('/home');
    await userEvent.click(screen.getByRole('button', { name: 'Language' }));
    const menu = screen.getByRole('menu', { name: 'Language' });
    const items = within(menu).getAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent)).toEqual(['English', '日本語']);
    expect(items[0].getAttribute('aria-checked')).toBe('true');
    await userEvent.click(items[1]);
    expect(getLang()).toBe('ja');
    expect(screen.queryByRole('menu', { name: /./ })).toBeNull();
  });
});

describe('App routes', () => {
  it('/ with a learn session goes to Home', async () => {
    setToken('tok', LATER, 'Wanda');
    api(OPEN);
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
        <Where />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Welcome back, Wanda' })).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe('/home');
  });
});
