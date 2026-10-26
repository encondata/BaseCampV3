// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@portal/auth/AuthContext', () => ({ useAuth: () => ({ status: 'anon' }) }));
vi.mock('@portal/pages/Login', () => ({
  default: ({ eyebrow, notice }: { eyebrow?: string; notice?: React.ReactNode }) => (
    <div>
      <p>portal sign-in · {eyebrow}</p>
      {notice}
    </div>
  ),
}));

import { getToken } from '../lib/session';
import { setLang } from '../lib/i18n';
import SignIn from './SignIn';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function renderSignIn() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<SignIn />} />
        <Route path="/training" element={<p>training page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const boxes = () => screen.getAllByRole('textbox', { name: /Character \d of 6/ }) as HTMLInputElement[];
const code = () => boxes().map((b) => b.value).join('');

beforeEach(() => { sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setLang('en'); });

describe('SignIn', () => {
  it('shows the code form first, with the account sign-in and the languages below', () => {
    renderSignIn();
    expect(screen.getByRole('heading', { name: 'Enter your learning code' })).toBeTruthy();
    expect(screen.getByText("It's in your invite email.")).toBeTruthy();
    expect(boxes()).toHaveLength(6);
    expect(screen.getByLabelText('Last name')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in with an account' })).toBeTruthy();
    for (const name of ['English', '日本語', '한국어', 'עברית']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
  });

  it('a paste fills every box, normalized', async () => {
    const user = userEvent.setup();
    renderSignIn();
    await user.click(boxes()[0]);
    await user.paste('k7q m2x');
    expect(code()).toBe('K7QM2X');
    expect(document.activeElement).toBe(boxes()[5]);
  });

  it('typing advances and backspace goes back', async () => {
    const user = userEvent.setup();
    renderSignIn();
    await user.click(boxes()[0]);
    await user.keyboard('k7');
    expect(code()).toBe('K7');
    expect(document.activeElement).toBe(boxes()[2]);
    await user.keyboard('{Backspace}');
    expect(code()).toBe('K');
    expect(document.activeElement).toBe(boxes()[1]);
  });

  it('ignores characters a code never has and reads O as 0 and I or L as 1', async () => {
    const user = userEvent.setup();
    renderSignIn();
    await user.click(boxes()[0]);
    await user.paste('o-i l u!9');
    expect(code()).toBe('0119');
  });

  it('posts the normalized code and last name, keeps the token and opens the training', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, {
      token: 'learn-tok', expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      person: { first_name: 'Kenji' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderSignIn();
    await user.click(boxes()[0]);
    await user.paste('k7q-m2x');
    await user.type(screen.getByLabelText('Last name'), '  Watanabe ');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('training page')).toBeTruthy();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8000/learn/auth/code');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ code: 'K7QM2X', last_name: 'Watanabe' });
    expect(getToken()).toBe('learn-tok');
  });

  it('asks for the whole code and the last name before sending anything', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderSignIn();
    await user.click(boxes()[0]);
    await user.paste('K7Q');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('alert').textContent).toBe('Enter the 6-character code and your last name.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'learn_code_invalid',
      "That code and last name don't match, or there have been too many tries. Check your invite email or wait a few minutes."],
    [429, 'rate_limited', 'Too many tries. Wait a few minutes and try again.'],
    [500, 'something_else', 'Something went wrong. Try again.'],
  ])('maps a %i %s to its message', async (status, errCode, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(status, { detail: { code: errCode } })));
    const user = userEvent.setup();
    renderSignIn();
    await user.click(boxes()[0]);
    await user.paste('K7QM2X');
    await user.type(screen.getByLabelText('Last name'), 'Watanabe');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(message));
    expect(getToken()).toBeNull();
    expect(screen.queryByText('training page')).toBeNull();
  });

  it('says so when the server cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const user = userEvent.setup();
    renderSignIn();
    await user.click(boxes()[0]);
    await user.paste('K7QM2X');
    await user.type(screen.getByLabelText('Last name'), 'Watanabe');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent)
      .toBe("Couldn't reach the server. Check your connection and try again."));
  });

  it('"Sign in with an account" shows the portal sign-in, and the code form comes back', async () => {
    const user = userEvent.setup();
    renderSignIn();
    await user.click(screen.getByRole('button', { name: 'Sign in with an account' }));
    expect(await screen.findByText('portal sign-in · ServerSherpa Learn')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Enter your learning code' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Use a learning code instead' }));
    expect(screen.getByRole('heading', { name: 'Enter your learning code' })).toBeTruthy();
  });

  it('switches language in place', () => {
    renderSignIn();
    fireEvent.click(screen.getByRole('button', { name: '日本語' }));
    expect(screen.queryByRole('heading', { name: 'Enter your learning code' })).toBeNull();
    expect(document.documentElement.lang).toBe('ja');
    fireEvent.click(screen.getByRole('button', { name: 'עברית' }));
    expect(document.documentElement.dir).toBe('rtl');
  });
});
