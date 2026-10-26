// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLang } from '../lib/i18n';
import { setToken } from '../lib/session';
import Quiz from './Quiz';

const LATER = new Date(Date.now() + 3_600_000).toISOString();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const QUESTIONS = [
  { id: 'q1', prompt: 'A friend asks which company you work for. What can you say?', multiple: false,
    choices: [{ id: 'c1', text: 'The name, nothing else' }, { id: 'c2', text: 'Only that it is a move' }] },
  { id: 'q2', prompt: 'Which of these are allowed?', multiple: true,
    choices: [{ id: 'd1', text: 'Badge on show' }, { id: 'd2', text: 'Photos of racks' }, { id: 'd3', text: 'Escorted visitors' }] },
];

/** The quiz GET, the quiz POST (answered with `grade`) and the training list. */
function api(grade: unknown | ((n: number) => unknown)) {
  let posts = 0;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/learn/training')) {
      return json(200, { groups: [{ initiative: null, due_on: null, items: [{
        assignment_id: 'a-9', title: 'Acme NDA', status: 'opened', minutes: 3, has_quiz: true,
        locked: false, signed_at: null }] }], complete: false, badge_uid: null });
    }
    if (init?.method === 'POST') {
      posts += 1;
      const out = typeof grade === 'function' ? (grade as (n: number) => unknown)(posts) : grade;
      return out instanceof Response ? out : json(200, out);
    }
    return json(200, QUESTIONS);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderQuiz() {
  return render(
    <MemoryRouter initialEntries={['/training/a-9/quiz']}>
      <Routes>
        <Route path="/training/:id/quiz" element={<Quiz />} />
        <Route path="/training/:id" element={<p>reader page</p>} />
        <Route path="/training" element={<p>training page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const posted = (m: ReturnType<typeof api>) =>
  m.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url, init]) =>
    [url, JSON.parse(String(init?.body))] as const);

async function answerBoth(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('radio', { name: 'Only that it is a move' }));
  await user.click(screen.getByRole('button', { name: 'Check answer' }));
  await user.click(await screen.findByRole('checkbox', { name: 'Badge on show' }));
  await user.click(screen.getByRole('checkbox', { name: 'Escorted visitors' }));
  await user.click(screen.getByRole('button', { name: 'See my score' }));
}

beforeEach(() => { sessionStorage.clear(); setToken('tok', LATER, 'Kenji'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setLang('en'); });

describe('Quiz', () => {
  it('asks one question at a time, single then multiple choice, and grades through the API', async () => {
    const fetchMock = api({ score_percent: 100, passed: true, attempts_left: 2, locked: false });
    const user = userEvent.setup();
    renderQuiz();
    expect(await screen.findByText('Question 1 of 2')).toBeTruthy();
    expect(screen.getByText('Acme NDA · quiz')).toBeTruthy();
    expect(screen.getByText('Choose one answer.')).toBeTruthy();
    const check = screen.getByRole('button', { name: 'Check answer' }) as HTMLButtonElement;
    expect(check.disabled).toBe(true);

    await user.click(screen.getByRole('radio', { name: 'Only that it is a move' }));
    expect(check.disabled).toBe(false);
    await user.click(check);

    expect(await screen.findByText('Question 2 of 2')).toBeTruthy();
    expect(screen.getByText('Choose every answer that applies.')).toBeTruthy();
    await user.click(screen.getByRole('checkbox', { name: 'Badge on show' }));
    await user.click(screen.getByRole('checkbox', { name: 'Escorted visitors' }));
    await user.click(screen.getByRole('button', { name: 'See my score' }));

    expect(await screen.findByText('You scored 100%')).toBeTruthy();
    expect(posted(fetchMock)).toEqual([[
      'http://localhost:8000/learn/assignments/a-9/quiz',
      { answers: { q1: ['c2'], q2: ['d1', 'd3'] } },
    ]]);

    await user.click(screen.getByRole('button', { name: 'Continue to sign' }));
    expect(await screen.findByText('reader page')).toBeTruthy();
  });

  it('a failed try shows the tries left and offers another with fresh questions', async () => {
    const fetchMock = api({ score_percent: 50, passed: false, attempts_left: 1, locked: false });
    const user = userEvent.setup();
    renderQuiz();
    await answerBoth(user);
    expect(await screen.findByText('You scored 50%')).toBeTruthy();
    expect(screen.getByText(/That's not a pass yet\. 1 try left/)).toBeTruthy();
    const gets = () => fetchMock.mock.calls.filter(([u, i]) => u.includes('/quiz') && !i?.method).length;
    expect(gets()).toBe(1);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Question 1 of 2')).toBeTruthy();
    expect(gets()).toBe(2);
  });

  it('shows the locked copy when the tries are used up', async () => {
    api({ score_percent: 25, passed: false, attempts_left: 0, locked: true });
    const user = userEvent.setup();
    renderQuiz();
    await answerBoth(user);
    expect(await screen.findByText("You've used all your tries. Your lead has been notified.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to my training' }).getAttribute('href')).toBe('/training');
  });

  it('keeps the answers and explains when the server refuses', async () => {
    api(json(409, { detail: { code: 'locked' } }));
    const user = userEvent.setup();
    renderQuiz();
    await answerBoth(user);
    expect(await screen.findByText(/This document is locked right now/)).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('button', { name: 'See my score' }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByRole('checkbox', { name: 'Badge on show' }) as HTMLInputElement).checked).toBe(true);
  });
});
