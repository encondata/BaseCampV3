// @vitest-environment jsdom
/**
 * The Quiz tab: the question pool (add / edit / delete / reorder) with the
 * question rules checked before anything is sent (at least one choice, at
 * least one marked correct), and the pass mark, attempts and failure action
 * that autosave through the document PATCH. Create/edit/delete/reorder follow
 * the API's learning:add / change / delete.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api';
import type { LearningDocument, QuizQuestion } from '../../lib/learning';

const auth = vi.hoisted(() => ({
  perms: { view: true, add: true, change: true, delete: true } as Record<string, boolean>,
}));
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    can: (resource: string, action = 'view') => resource === 'learning' && auth.perms[action] === true,
    scope: { global: true },
    preferences: {},
    updatePreferences: vi.fn(),
    hasRole: () => false,
  }),
}));

const api = vi.hoisted(() => ({
  listQuestions: vi.fn(),
  createQuestion: vi.fn(),
  patchQuestion: vi.fn(),
  deleteQuestion: vi.fn(),
  reorderQuestions: vi.fn(),
}));
vi.mock('../../lib/learning', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/learning')>()),
  ...api,
}));

const { default: QuizEditor } = await import('./QuizEditor');

const DOC = {
  id: 'd1', title: 'Acme NDA', quiz_enabled: true, quiz_pass_percent: 80,
  quiz_max_attempts: 3, quiz_fail_action: 'retry',
} as LearningDocument;

const q = (id: string, prompt: string, over: Partial<QuizQuestion> = {}): QuizQuestion => ({
  id, document_id: 'd1', prompt,
  choices: [{ id: `${id}a`, text: 'Yes' }, { id: `${id}b`, text: 'No' }, { id: `${id}c`, text: 'Maybe' }],
  correct_choice_ids: [`${id}b`], translations: {}, position: 0, created_at: '2026-10-01T00:00:00Z', ...over,
});

const Q1 = q('q1', 'May you share the NDA?');
const Q2 = q('q2', 'Who can you tell?');

const onSave = vi.fn();

function renderEditor(doc: LearningDocument = DOC) {
  return render(<QuizEditor doc={doc} onSave={onSave} />);
}

beforeEach(() => {
  auth.perms = { view: true, add: true, change: true, delete: true };
  api.listQuestions.mockReset().mockResolvedValue([Q1, Q2]);
  api.createQuestion.mockReset().mockImplementation(async (_d: string, body: object) => ({ ...q('q9', 'x'), ...body }));
  api.patchQuestion.mockReset().mockImplementation(async (id: string, body: object) => ({ ...q(id, 'x'), ...body }));
  api.deleteQuestion.mockReset().mockResolvedValue(undefined);
  api.reorderQuestions.mockReset().mockResolvedValue([Q2, Q1]);
  onSave.mockReset().mockResolvedValue(true);
});
afterEach(cleanup);

it('lists the questions with their choice and correct-answer counts', async () => {
  renderEditor();
  const row = (await screen.findByText('May you share the NDA?')).closest('.dir-row') as HTMLElement;
  expect(within(row).getByText('3 choices')).toBeTruthy();
  expect(within(row).getByText('1 correct')).toBeTruthy();
  expect(api.listQuestions).toHaveBeenCalledWith('d1');
});

it('Add question refuses no choices and no correct answer, then saves two choices', async () => {
  const user = userEvent.setup();
  renderEditor();
  await screen.findByText('Who can you tell?');
  await user.click(screen.getByRole('button', { name: 'Add question' }));
  const dialog = await screen.findByRole('dialog', { name: /new question/i });

  await user.type(within(dialog).getByLabelText('Question'), 'Who may you tell?');
  // every choice blank: not enough
  await user.click(within(dialog).getByRole('button', { name: 'Add question' }));
  expect(within(dialog).getByText('A question needs at least one choice.')).toBeTruthy();
  expect(api.createQuestion).not.toHaveBeenCalled();

  await user.type(within(dialog).getByLabelText('Choice 1'), 'Nobody');
  await user.type(within(dialog).getByLabelText('Choice 2'), 'Anyone');
  await user.click(within(dialog).getByRole('button', { name: 'Add question' }));
  expect(within(dialog).getByText('Mark at least one choice as correct.')).toBeTruthy();
  expect(api.createQuestion).not.toHaveBeenCalled();

  await user.click(within(dialog).getByRole('checkbox', { name: 'Choice 1 is correct' }));
  await user.click(within(dialog).getByRole('button', { name: 'Add question' }));
  await waitFor(() => expect(api.createQuestion).toHaveBeenCalledTimes(1));
  const [docId, body] = api.createQuestion.mock.calls[0];
  expect(docId).toBe('d1');
  expect(body.prompt).toBe('Who may you tell?');
  expect(body.choices.map((c: { text: string }) => c.text)).toEqual(['Nobody', 'Anyone']);
  // new choices carry ids so the correct one can be named
  expect(body.choices[0].id).toBeTruthy();
  expect(body.correct_choice_ids).toEqual([body.choices[0].id]);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('saves a single-answer question (an acknowledgment with one choice)', async () => {
  const user = userEvent.setup();
  renderEditor();
  await screen.findByText('Who can you tell?');
  await user.click(screen.getByRole('button', { name: 'Add question' }));
  const dialog = await screen.findByRole('dialog', { name: /new question/i });

  await user.type(within(dialog).getByLabelText('Question'), 'I have read and understand this document.');
  await user.type(within(dialog).getByLabelText('Choice 1'), 'Yes');   // choice 2 stays blank
  await user.click(within(dialog).getByRole('button', { name: 'Add question' }));
  expect(within(dialog).getByText('Mark at least one choice as correct.')).toBeTruthy();
  expect(api.createQuestion).not.toHaveBeenCalled();

  await user.click(within(dialog).getByRole('checkbox', { name: 'Choice 1 is correct' }));
  await user.click(within(dialog).getByRole('button', { name: 'Add question' }));
  await waitFor(() => expect(api.createQuestion).toHaveBeenCalledTimes(1));
  const body = api.createQuestion.mock.calls[0][1];
  expect(body.choices.map((c: { text: string }) => c.text)).toEqual(['Yes']);
  expect(body.correct_choice_ids).toEqual([body.choices[0].id]);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('blank choices are dropped and a blank question is refused', async () => {
  const user = userEvent.setup();
  renderEditor();
  await screen.findByText('Who can you tell?');
  await user.click(screen.getByRole('button', { name: 'Add question' }));
  const dialog = await screen.findByRole('dialog', { name: /new question/i });
  await user.click(within(dialog).getByRole('button', { name: 'Add question' }));
  expect(within(dialog).getByText('Write the question.')).toBeTruthy();

  await user.type(within(dialog).getByLabelText('Question'), 'Q?');
  await user.click(within(dialog).getByRole('button', { name: 'Add choice' }));
  await user.type(within(dialog).getByLabelText('Choice 1'), 'A');
  await user.type(within(dialog).getByLabelText('Choice 3'), 'C');   // choice 2 stays blank
  await user.click(within(dialog).getByRole('checkbox', { name: 'Choice 3 is correct' }));
  await user.click(within(dialog).getByRole('button', { name: 'Add question' }));
  await waitFor(() => expect(api.createQuestion).toHaveBeenCalled());
  const body = api.createQuestion.mock.calls[0][1];
  expect(body.choices.map((c: { text: string }) => c.text)).toEqual(['A', 'C']);
  expect(body.correct_choice_ids).toEqual([body.choices[1].id]);
});

it('Edit keeps choice ids and PATCHes the question', async () => {
  const user = userEvent.setup();
  renderEditor();
  const row = (await screen.findByText('May you share the NDA?')).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: 'Edit' }));
  const dialog = await screen.findByRole('dialog', { name: /edit question/i });
  expect((within(dialog).getByLabelText('Choice 2') as HTMLInputElement).value).toBe('No');
  expect((within(dialog).getByRole('checkbox', { name: 'Choice 2 is correct' }) as HTMLInputElement).checked).toBe(true);

  await user.clear(within(dialog).getByLabelText('Choice 2'));
  await user.type(within(dialog).getByLabelText('Choice 2'), 'Never');
  await user.click(within(dialog).getByRole('button', { name: 'Save question' }));
  await waitFor(() => expect(api.patchQuestion).toHaveBeenCalledWith('q1', {
    prompt: 'May you share the NDA?',
    choices: [{ id: 'q1a', text: 'Yes' }, { id: 'q1b', text: 'Never' }, { id: 'q1c', text: 'Maybe' }],
    correct_choice_ids: ['q1b'],
  }));
});

it('removing a choice also drops it from the question’s translations', async () => {
  api.listQuestions.mockResolvedValue([q('q1', 'May you share the NDA?', {
    translations: { ja: { prompt: 'x', choices: { q1a: 'はい', q1c: 'たぶん' } } },
  })]);
  const user = userEvent.setup();
  renderEditor();
  const row = (await screen.findByText('May you share the NDA?')).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: 'Edit' }));
  const dialog = await screen.findByRole('dialog', { name: /edit question/i });
  await user.click(within(dialog).getByRole('button', { name: 'Remove choice 3' }));
  await user.click(within(dialog).getByRole('button', { name: 'Save question' }));
  await waitFor(() => expect(api.patchQuestion).toHaveBeenCalled());
  const body = api.patchQuestion.mock.calls[0][1];
  expect(body.choices.map((c: { id: string }) => c.id)).toEqual(['q1a', 'q1b']);
  expect(body.translations).toEqual({ ja: { prompt: 'x', choices: { q1a: 'はい' } } });
});

it('a server refusal shows in the modal', async () => {
  api.patchQuestion.mockRejectedValueOnce(new ApiError(422, 'no_correct_choice', { code: 'no_correct_choice', message: 'x' }));
  const user = userEvent.setup();
  renderEditor();
  const row = (await screen.findByText('May you share the NDA?')).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: 'Edit' }));
  const dialog = await screen.findByRole('dialog', { name: /edit question/i });
  await user.click(within(dialog).getByRole('button', { name: 'Save question' }));
  expect(await within(dialog).findByText('Mark at least one choice as correct.')).toBeTruthy();
});

it('Delete asks first, then removes the question', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const user = userEvent.setup();
  renderEditor();
  const row = (await screen.findByText('Who can you tell?')).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: 'Delete' }));
  expect(confirm).toHaveBeenCalled();
  await waitFor(() => expect(api.deleteQuestion).toHaveBeenCalledWith('q2'));
  await waitFor(() => expect(screen.queryByText('Who can you tell?')).toBeNull());
});

it('Move down reorders the pool', async () => {
  const user = userEvent.setup();
  renderEditor();
  const row = (await screen.findByText('May you share the NDA?')).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: 'Move down' }));
  await waitFor(() => expect(api.reorderQuestions).toHaveBeenCalledWith('d1', ['q2', 'q1']));
});

it('pass mark, attempts and failure action autosave through the document PATCH', async () => {
  renderEditor();
  await screen.findByText('Who can you tell?');
  const pass = screen.getByLabelText('Pass mark (percent)') as HTMLInputElement;
  expect(pass.value).toBe('80');
  fireEvent.change(pass, { target: { value: '90' } });
  fireEvent.blur(pass);
  await waitFor(() => expect(onSave).toHaveBeenLastCalledWith({ quiz_pass_percent: 90 }));

  const attempts = screen.getByLabelText('Attempts allowed') as HTMLInputElement;
  expect(attempts.value).toBe('3');
  fireEvent.change(attempts, { target: { value: '' } });
  fireEvent.blur(attempts);
  await waitFor(() => expect(onSave).toHaveBeenLastCalledWith({ quiz_max_attempts: null }));

  fireEvent.click(screen.getByRole('button', { name: /Lock the quiz/ }));
  await waitFor(() => expect(onSave).toHaveBeenLastCalledWith({ quiz_fail_action: 'lock' }));
});

it('a pass mark outside 1 to 100 is refused where it is typed', async () => {
  renderEditor();
  await screen.findByText('Who can you tell?');
  const pass = screen.getByLabelText('Pass mark (percent)');
  fireEvent.change(pass, { target: { value: '101' } });
  fireEvent.blur(pass);
  expect(onSave).not.toHaveBeenCalled();
  expect(screen.getByText(/between 1 and 100/i)).toBeTruthy();
});

it('locking with no attempt limit is refused while the quiz is on', async () => {
  renderEditor({ ...DOC, quiz_max_attempts: null });
  await screen.findByText('Who can you tell?');
  fireEvent.click(screen.getByRole('button', { name: /Lock the quiz/ }));
  expect(onSave).not.toHaveBeenCalled();
  expect(screen.getByText(/set how many attempts are allowed/i)).toBeTruthy();
});

it('view-only managers read the pool and the settings with no controls', async () => {
  auth.perms = { view: true };
  renderEditor();
  await screen.findByText('Who can you tell?');
  expect(screen.queryByRole('button', { name: 'Add question' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Move down' })).toBeNull();
  expect(screen.queryByLabelText('Pass mark (percent)')).toBeNull();
  expect(screen.getByText('80%')).toBeTruthy();
});

it('add without learning:add hides Add question but keeps Edit', async () => {
  auth.perms = { view: true, change: true };
  renderEditor();
  await screen.findByText('Who can you tell?');
  expect(screen.queryByRole('button', { name: 'Add question' })).toBeNull();
  expect(screen.getAllByRole('button', { name: 'Edit' }).length).toBe(2);
  expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
});

it('says when the quiz is switched off for the document', async () => {
  renderEditor({ ...DOC, quiz_enabled: false });
  expect(await screen.findByText(/the quiz is off for this document/i)).toBeTruthy();
});

it('leaving the pass mark box untouched shows no error', async () => {
  renderEditor({ ...DOC, quiz_pass_percent: null });
  await screen.findByText('Who can you tell?');
  fireEvent.blur(screen.getByLabelText('Pass mark (percent)'));
  expect(screen.queryByText(/between 1 and 100/i)).toBeNull();
  expect(onSave).not.toHaveBeenCalled();
});
