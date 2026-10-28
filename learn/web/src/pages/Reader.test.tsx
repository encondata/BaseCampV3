// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLang } from '../lib/i18n';
import { setToken } from '../lib/session';
import type { AssignmentRead } from '../lib/training';
import Reader from './Reader';

const ID = '0b6e5a2c-4f1d-4d57-9a0e-3c1f2a7b8d44';
const LATER = new Date(Date.now() + 3_600_000).toISOString();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const DOC: AssignmentRead = {
  title: 'Acme site rules', html: '<h2>Badges</h2><p>Wear your badge.</p>', language: 'en', fallback: false,
  version_no: 2, change_note: null, sign_style: 'typed_name', require_scroll: true,
  min_read_seconds: null, has_quiz: false, quiz_passed: false,
};

const TRAINING = {
  groups: [{ initiative: null, due_on: null, items: [1, 2, 3, 4, 5].map((n) => ({
    assignment_id: n === 4 ? ID : `a-${n}`, title: `Doc ${n}`, status: 'assigned', minutes: 4,
    has_quiz: false, locked: false, signed_at: null })) }],
  complete: false, badge_uid: null,
};

type Doc = AssignmentRead;

/** The assignment GET (with `over` applied), the training list and the sign POST. */
function api(over: Partial<Doc> = {}, sign: Response | (() => Response) = json(200, {
  signoff_id: 's-1', signed_at: '2026-11-05T10:00:00Z', complete: false,
})) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/learn/training')) return json(200, TRAINING);
    if (init?.method === 'POST') return typeof sign === 'function' ? sign() : sign.clone();
    return json(200, { ...DOC, ...over });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const signCalls = (m: ReturnType<typeof api>) =>
  m.mock.calls.filter(([, init]) => init?.method === 'POST');
const signBody = (m: ReturnType<typeof api>) => JSON.parse(String(signCalls(m)[0][1]?.body));

function renderReader() {
  return render(
    <MemoryRouter initialEntries={[`/training/${ID}`]}>
      <Routes>
        <Route path="/training/:id" element={<Reader />} />
        <Route path="/training/:id/quiz" element={<p>quiz page</p>} />
        <Route path="/training" element={<p>training page</p>} />
        <Route path="/done" element={<p>done page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** jsdom lays nothing out; give the scroll box a height to scroll through. */
function overflow() {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100);
}
function scrollToEnd(box: HTMLElement) {
  box.scrollTop = 900;
  fireEvent.scroll(box);
}

beforeEach(() => { sessionStorage.clear(); setToken('tok', LATER, 'Kenji'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); setLang('en'); });

describe('Reader', () => {
  it('shows the position, version and document', async () => {
    api();
    renderReader();
    expect(await screen.findByRole('heading', { name: 'Acme site rules' })).toBeTruthy();
    expect(await screen.findByText('4 of 5 · v2')).toBeTruthy();
    expect(screen.getByText('Badges')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back' }).getAttribute('href')).toBe('/training');
  });

  it('asks for the language the worker chose, and reads the document in the language it came in', async () => {
    setLang('he');
    const fetchMock = api({ language: 'he' });
    renderReader();
    const body = await screen.findByRole('region', { name: 'טקסט המסמך' });
    expect(body.getAttribute('dir')).toBe('rtl');
    expect(body.getAttribute('lang')).toBe('he');
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith(`/learn/assignments/${ID}?lang=he`))).toBe(true);
  });

  it('shows the not-translated and what-changed notices', async () => {
    api({ fallback: true, change_note: 'Dock hours moved to 7 AM.' });
    renderReader();
    expect(await screen.findByText("This document isn't translated yet. You're reading the English version."))
      .toBeTruthy();
    expect(screen.getByText('What changed: Dock hours moved to 7 AM.')).toBeTruthy();
  });

  it('shows the document first, and "Take the quiz" in place of the signature while the quiz is open', async () => {
    api({ has_quiz: true, quiz_passed: false });
    renderReader();
    expect(await screen.findByText('Badges')).toBeTruthy();
    const quiz = screen.getByRole('link', { name: 'Take the quiz' });
    expect(quiz.getAttribute('href')).toBe(`/training/${ID}/quiz`);
    expect(screen.queryByRole('button', { name: 'Sign and continue' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByLabelText('Type your full name to sign')).toBeNull();
  });

  it('shows the sign step once the quiz is passed', async () => {
    api({ has_quiz: true, quiz_passed: true });
    renderReader();
    expect(await screen.findByLabelText('Type your full name to sign')).toBeTruthy();
  });

  it('back from a passed quiz, the scroll and reading-time gates are already met', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    overflow();
    const fetchMock = api({ has_quiz: true, quiz_passed: true, min_read_seconds: 180 });
    renderReader();
    const sign = await screen.findByRole('button', { name: 'Sign and continue' });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('Type your full name to sign'), { target: { value: 'Kenji Watanabe' } });
    // no scrolling, no waiting: the reading came before the quiz
    fireEvent.click(sign);
    expect(await screen.findByText('training page')).toBeTruthy();
    expect(signBody(fetchMock)).toMatchObject({ scrolled_to_end: true, version_no: 2 });
  });

  it('a version published while reading: the server refuses and the new one loads', async () => {
    let version = 2;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/learn/training')) return json(200, TRAINING);
      if (init?.method === 'POST') {
        version = 3;
        return json(409, { detail: { code: 'version_changed' } });
      }
      return json(200, { ...DOC, require_scroll: false, version_no: version,
        html: version === 3 ? '<p>New rules.</p>' : DOC.html });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderReader();
    const sign = await screen.findByRole('button', { name: 'Sign and continue' });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('Type your full name to sign'), { target: { value: 'Kenji Watanabe' } });
    fireEvent.click(sign);
    expect(await screen.findByText('New rules.')).toBeTruthy();
    expect(screen.getByText('This document was just updated. Read the new version, then sign.')).toBeTruthy();
    // a fresh start on the new version: nothing ticked
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });

  it('a new version after a passed quiz brings the scroll gate back: the worker hasn\'t read it', async () => {
    overflow();
    let version = 2;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/learn/training')) return json(200, TRAINING);
      if (init?.method === 'POST') {
        version = 3;
        return json(409, { detail: { code: 'version_changed' } });
      }
      return json(200, { ...DOC, has_quiz: true, quiz_passed: true, version_no: version,
        html: version === 3 ? '<p>New rules.</p>' : DOC.html });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderReader();
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('Type your full name to sign'), { target: { value: 'Kenji Watanabe' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign and continue' }));
    expect(await screen.findByText('New rules.')).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('Type your full name to sign'), { target: { value: 'Kenji Watanabe' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign and continue' }));
    expect(screen.getByText('Scroll to the end of the document first.')).toBeTruthy();
    expect(signCalls(fetchMock)).toHaveLength(1);
  });

  it('explains what is missing before it calls the server, in the server\'s order', async () => {
    overflow();
    const fetchMock = api();
    const user = userEvent.setup();
    renderReader();
    const sign = await screen.findByRole('button', { name: 'Sign and continue' });
    expect((sign as HTMLButtonElement).disabled).toBe(false);

    await user.click(sign);
    expect(screen.getByRole('status').textContent).toBe("Tick the box to say you've read it and agree.");

    await user.click(screen.getByRole('checkbox', { name: "I've read Acme site rules and agree to follow it." }));
    await user.click(sign);
    expect(screen.getByRole('status').textContent).toBe('Type your full name to sign.');

    await user.type(screen.getByLabelText('Type your full name to sign'), 'Kenji Watanabe');
    await user.click(sign);
    expect(screen.getByRole('status').textContent).toBe('Scroll to the end of the document first.');
    expect(screen.queryByText(/^Read to the end/)).toBeNull();
    expect(signCalls(fetchMock)).toHaveLength(0);

    scrollToEnd(screen.getByRole('region', { name: 'Document text' }));
    expect(await screen.findByText(/^Read to the end · /)).toBeTruthy();
    await user.click(sign);
    expect(await screen.findByText('training page')).toBeTruthy();
    expect(signBody(fetchMock)).toEqual({
      agreed: true, typed_name: 'Kenji Watanabe', language: 'en', scrolled_to_end: true, version_no: 2,
    });
    expect(String(signCalls(fetchMock)[0][0])).toBe(`http://localhost:8000/learn/assignments/${ID}/sign`);
  });

  it('holds the signature until the minimum reading time has passed', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const fetchMock = api({ min_read_seconds: 90, require_scroll: false });
    renderReader();
    const sign = await screen.findByRole('button', { name: 'Sign and continue' });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('Type your full name to sign'), { target: { value: 'Kenji Watanabe' } });

    await act(async () => { vi.advanceTimersByTime(30_000); });
    fireEvent.click(sign);
    expect(screen.getByRole('status').textContent).toBe('Keep reading: you can sign in 1:00.');
    expect(signCalls(fetchMock)).toHaveLength(0);

    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText('Read to the end · 1:30')).toBeTruthy();
    fireEvent.click(sign);
    expect(await screen.findByText('training page')).toBeTruthy();
    expect(signCalls(fetchMock)).toHaveLength(1);
  });

  it('sends a drawn signature as base64 without the data: prefix', async () => {
    const ctx = { scale: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
      save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(), clearRect: vi.fn() };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,iVBORw0KGgoAAAA=');
    const fetchMock = api({ sign_style: 'drawn_signature' });
    renderReader();
    const sign = await screen.findByRole('button', { name: 'Sign and continue' });
    expect(screen.queryByLabelText('Type your full name to sign')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox'));

    fireEvent.click(sign);
    expect(screen.getByRole('status').textContent).toBe('Draw your signature to sign.');

    const pad = screen.getByLabelText('Draw your signature');
    fireEvent.pointerDown(pad, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(pad, { clientX: 40, clientY: 30, pointerId: 1 });
    fireEvent.pointerUp(pad, { clientX: 40, clientY: 30, pointerId: 1 });
    expect(ctx.stroke).toHaveBeenCalled();

    fireEvent.click(sign);
    expect(await screen.findByText('training page')).toBeTruthy();
    expect(signBody(fetchMock)).toEqual({
      agreed: true, signature_png_b64: 'iVBORw0KGgoAAAA=', language: 'en', scrolled_to_end: true, version_no: 2,
    });

    cleanup();
  });

  it('clearing the pad takes the signature back', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    api({ sign_style: 'drawn_signature' });
    const user = userEvent.setup();
    renderReader();
    await user.click(await screen.findByRole('button', { name: 'Clear' }));
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Sign and continue' }));
    expect(screen.getByRole('status').textContent).toBe('Draw your signature to sign.');
  });

  it('a checkbox document needs only the box', async () => {
    const fetchMock = api({ sign_style: 'checkbox' }, json(200, { signoff_id: 's', signed_at: 'x', complete: true }));
    renderReader();
    await screen.findByRole('button', { name: 'Sign and continue' });
    expect(screen.queryByLabelText('Type your full name to sign')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Sign and continue' }));
    // everything signed: on to the time clock code
    expect(await screen.findByText('done page')).toBeTruthy();
    expect(signBody(fetchMock)).toEqual({ agreed: true, language: 'en', scrolled_to_end: true, version_no: 2 });
  });

  it('turns the server refusals into friendly lines', async () => {
    api({}, json(422, { detail: { code: 'read_time', seconds_left: 75 } }));
    renderReader();
    await screen.findByRole('button', { name: 'Sign and continue' });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('Type your full name to sign'), { target: { value: 'Kenji Watanabe' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign and continue' }));
    expect(await screen.findByText('Keep reading: you can sign in 1:15.')).toBeTruthy();
  });

  it('says the document is locked when it is', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      (url.endsWith('/learn/training') ? json(200, TRAINING) : json(409, { detail: { code: 'locked' } }))));
    renderReader();
    expect(await screen.findByText(/This document is locked right now/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('is not marked as read to the end when the text grows after it first fit', async () => {
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(50);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100);
    api({ html: '<p>Short.</p><img alt="map" src="/map.png">' });
    renderReader();
    const sign = await screen.findByRole('button', { name: 'Sign and continue' });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('Type your full name to sign'), { target: { value: 'Kenji' } });
    // the image arrives and the text is suddenly taller than the box
    height.mockReturnValue(1000);
    fireEvent.load(screen.getByRole('img', { name: 'map' }));
    fireEvent.click(sign);
    expect(screen.getByRole('status').textContent).toBe('Scroll to the end of the document first.');
  });

  it('measures again when the box or its text is resized', async () => {
    const watchers: (() => void)[] = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: () => void) { watchers.push(cb); }
      observe() {}
      disconnect() {}
    });
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(50);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100);
    api();
    renderReader();
    const sign = await screen.findByRole('button', { name: 'Sign and continue' });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('Type your full name to sign'), { target: { value: 'Kenji' } });
    height.mockReturnValue(1000);
    act(() => { watchers.forEach((w) => w()); });
    fireEvent.click(sign);
    expect(screen.getByRole('status').textContent).toBe('Scroll to the end of the document first.');
  });

  it.each([
    ['a path with dots', '..%2F..%2Fauth%2Flogout'],
    ['a nested path', 'x%2F..%2F..%2Fpeople'],
    ['a query', 'a-4%3Fx%3D1'],
  ])('never sends %s from the address to the server', (_what, raw) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter initialEntries={[`/training/${raw}`]}>
        <Routes>
          <Route path="/training/:id" element={<Reader />} />
          <Route path="/training" element={<p>training page</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('training page')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
