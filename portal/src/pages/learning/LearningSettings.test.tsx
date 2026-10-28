// @vitest-environment jsdom
/**
 * /learning/settings — the learning policy form: it shows what GET returns,
 * validates before it sends, PUTs only the fields that changed (blank
 * nullable numbers go out as null), edits email text per template and
 * language with Reset to default, and is read-only without learning:change.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api';
import type { LearningSettings as Settings } from '../../lib/learning';

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../lib/notificationsContext', () => ({ useToast: () => toast }));

const auth = vi.hoisted(() => ({ change: true }));
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    can: (resource: string, action = 'view') =>
      resource === 'learning' && (action === 'view' || (action === 'change' && auth.change)),
    scope: { global: true },
  }),
}));

const api = vi.hoisted(() => ({ getLearningSettings: vi.fn(), putLearningSettings: vi.fn() }));
vi.mock('../../lib/learning', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/learning')>()), ...api,
}));

const { default: LearningSettings } = await import('./LearningSettings');

const SETTINGS: Settings = {
  code_max_failures: 10, code_lockout_seconds: 900, ip_limit: 30, ip_window_seconds: 300,
  global_limit: 300, general_code_days: null, default_validity_days: null,
  invite_offset_days: 7, invite_time: '08:00', reminder_offsets: [5, 3], due_offset_days: 2,
  retention_days: null, brand_line: 'Acme Moving', email_text: {},
  languages: ['en', 'ja', 'ko', 'he'],
  available_languages: ['en', 'zh-Hans', 'he', 'ja', 'ko', 'ms', 'nl'],
};

const value = (label: string) => (screen.getByLabelText(label) as HTMLInputElement).value;
const type = async (label: string, text: string) => {
  const input = screen.getByLabelText(label);
  await userEvent.setup().clear(input);
  if (text) await userEvent.setup().type(input, text);
};
const save = () => userEvent.setup().click(screen.getByRole('button', { name: 'Save changes' }));

function renderPage() {
  return render(<MemoryRouter><LearningSettings /></MemoryRouter>);
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();   // jsdom has none; ComboBox scrolls its active option
  auth.change = true;
  api.getLearningSettings.mockResolvedValue(SETTINGS);
  api.putLearningSettings.mockImplementation(async (patch) => ({ ...SETTINGS, ...patch }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('shows exactly what the API returns', async () => {
  renderPage();
  await screen.findByLabelText('Failed attempts before a lockout');
  expect(value('Failed attempts before a lockout')).toBe('10');
  expect(value('Lockout length (seconds)')).toBe('900');
  expect(value('Failed attempts per IP address')).toBe('30');
  expect(value('Counting window (seconds)')).toBe('300');
  expect(value('Failed attempts across all addresses')).toBe('300');
  expect(value('General codes expire after (days)')).toBe('');
  expect(value('Documents stay valid for (days)')).toBe('');
  expect(value('Send invites (days before the start)')).toBe('7');
  expect((screen.getByRole('combobox', { name: 'Send at' }) as HTMLInputElement).value).toBe('8:00 AM');
  expect(screen.getByText('5 days before')).toBeTruthy();
  expect(screen.getByText('3 days before')).toBeTruthy();
  expect(value('Due (days before the start)')).toBe('2');
  expect(value('Keep sign-off records for (days)')).toBe('');
  expect(value('Branding line')).toBe('Acme Moving');
});

it('starts clean: nothing to save or discard', async () => {
  renderPage();
  await screen.findByLabelText('Branding line');
  expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
});

it('PUTs only the changed fields', async () => {
  renderPage();
  await screen.findByLabelText('Branding line');
  await type('Failed attempts before a lockout', '5');
  await type('Due (days before the start)', '4');
  await save();
  await waitFor(() => expect(api.putLearningSettings).toHaveBeenCalledTimes(1));
  expect(api.putLearningSettings).toHaveBeenCalledWith({ code_max_failures: 5, due_offset_days: 4 });
  expect(toast).toHaveBeenCalled();
});

it('sends a filled nullable number as a number and a cleared one as null', async () => {
  api.getLearningSettings.mockResolvedValue({ ...SETTINGS, general_code_days: 14, retention_days: null });
  renderPage();
  await screen.findByLabelText('Branding line');
  await type('General codes expire after (days)', '');
  await type('Keep sign-off records for (days)', '365');
  await save();
  await waitFor(() => expect(api.putLearningSettings).toHaveBeenCalled());
  expect(api.putLearningSettings).toHaveBeenCalledWith({ general_code_days: null, retention_days: 365 });
});

it('blocks a number below 1 and says why', async () => {
  renderPage();
  await screen.findByLabelText('Branding line');
  await type('Lockout length (seconds)', '0');
  expect(screen.getByText('Enter a whole number of 1 or more.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);
  expect(api.putLearningSettings).not.toHaveBeenCalled();
});

it('blocks a required number left blank', async () => {
  renderPage();
  await screen.findByLabelText('Branding line');
  await type('Failed attempts per IP address', '');
  expect(screen.getByText('Enter a whole number of 1 or more.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);
});

it('adds and removes reminder days, sending them latest first', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByLabelText('Branding line');
  await user.click(screen.getByRole('button', { name: 'Remove 5 days before' }));
  await user.click(screen.getByRole('combobox', { name: 'Add a reminder day' }));
  await user.click(await screen.findByRole('button', { name: '1 day before' }));
  await user.click(screen.getByRole('combobox', { name: 'Add a reminder day' }));
  await user.click(await screen.findByRole('button', { name: '7 days before' }));
  await save();
  await waitFor(() => expect(api.putLearningSettings).toHaveBeenCalled());
  expect(api.putLearningSettings).toHaveBeenCalledWith({ reminder_offsets: [7, 3, 1] });
});

it('allows no reminders at all', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByLabelText('Branding line');
  await user.click(screen.getByRole('button', { name: 'Remove 5 days before' }));
  await user.click(screen.getByRole('button', { name: 'Remove 3 days before' }));
  expect(screen.getByText('No reminders.')).toBeTruthy();
  await save();
  await waitFor(() => expect(api.putLearningSettings).toHaveBeenCalled());
  expect(api.putLearningSettings).toHaveBeenCalledWith({ reminder_offsets: [] });
});

it('names the reminders group by its label', async () => {
  renderPage();
  await screen.findByLabelText('Branding line');
  expect(screen.getByRole('group', { name: 'Reminders (days before the start)' })).toBeTruthy();
});

it('compares the offered languages as a set, not by order', async () => {
  api.getLearningSettings.mockResolvedValue({ ...SETTINGS, languages: ['he', 'en', 'ko', 'ja'] });
  renderPage();
  await screen.findByLabelText('Branding line');
  expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);
});

it('sends the send time as HH:MM', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByLabelText('Branding line');
  await user.click(screen.getByRole('combobox', { name: 'Send at' }));
  await user.click(await screen.findByRole('button', { name: '9:30 AM' }));
  await save();
  await waitFor(() => expect(api.putLearningSettings).toHaveBeenCalled());
  expect(api.putLearningSettings).toHaveBeenCalledWith({ invite_time: '09:30' });
});

it('keeps English on and sends the offered languages in the API order', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByLabelText('Branding line');
  const panel = screen.getByRole('region', { name: 'Languages' });
  // English is always on: never a chip, never offered
  expect(within(panel).queryByRole('button', { name: 'Remove English' })).toBeNull();
  await user.click(within(panel).getByRole('button', { name: 'Remove Korean' }));
  await user.click(within(panel).getByRole('combobox', { name: 'Add a language' }));
  expect(screen.queryByRole('button', { name: 'English' })).toBeNull();
  await user.click(await screen.findByRole('button', { name: 'Malay' }));
  expect(within(panel).getByRole('button', { name: 'Remove Malay' })).toBeTruthy();
  await save();
  await waitFor(() => expect(api.putLearningSettings).toHaveBeenCalled());
  expect(api.putLearningSettings).toHaveBeenCalledWith({ languages: ['en', 'he', 'ja', 'ms'] });
});

it('offers any language the API lists, under its English name', async () => {
  const user = userEvent.setup();
  api.getLearningSettings.mockResolvedValue({ ...SETTINGS, languages: ['en'] });
  renderPage();
  await screen.findByLabelText('Branding line');
  await user.click(screen.getByRole('combobox', { name: 'Add a language' }));
  for (const name of ['Simplified Chinese', 'Hebrew', 'Japanese', 'Korean', 'Malay', 'Dutch']) {
    expect(await screen.findByRole('button', { name })).toBeTruthy();
  }
});

it('edits email text for a template and language', async () => {
  renderPage();
  await screen.findByLabelText('Branding line');
  expect(value('Subject')).toBe('');
  await type('Subject', 'Your training is ready');
  await userEvent.setup().type(screen.getByLabelText('Intro'), 'Please sign by Friday.');
  await save();
  await waitFor(() => expect(api.putLearningSettings).toHaveBeenCalled());
  expect(api.putLearningSettings).toHaveBeenCalledWith({
    email_text: { invite: { en: { subject: 'Your training is ready', intro: 'Please sign by Friday.' } } },
  });
});

it('picks the template and language being edited', async () => {
  const user = userEvent.setup();
  api.getLearningSettings.mockResolvedValue({
    ...SETTINGS,
    email_text: { reminder: { ja: { subject: 'リマインダー', intro: 'お願いします' } } },
  });
  renderPage();
  await screen.findByLabelText('Branding line');
  await user.click(screen.getByRole('combobox', { name: 'Template' }));
  await user.click(await screen.findByRole('button', { name: 'Reminder' }));
  await user.click(screen.getByRole('combobox', { name: 'Language' }));
  await user.click(await screen.findByRole('button', { name: 'Japanese' }));
  expect(value('Subject')).toBe('リマインダー');
  expect(value('Intro')).toBe('お願いします');
});

it('Reset to default removes the override', async () => {
  api.getLearningSettings.mockResolvedValue({
    ...SETTINGS,
    email_text: {
      invite: { en: { subject: 'Hello', intro: 'Intro' }, ja: { subject: 'こんにちは', intro: 'はじめに' } },
    },
  });
  renderPage();
  await screen.findByLabelText('Branding line');
  expect(value('Subject')).toBe('Hello');
  await userEvent.setup().click(screen.getByRole('button', { name: 'Reset to default' }));
  expect(value('Subject')).toBe('');
  await save();
  await waitFor(() => expect(api.putLearningSettings).toHaveBeenCalled());
  expect(api.putLearningSettings).toHaveBeenCalledWith({
    email_text: { invite: { ja: { subject: 'こんにちは', intro: 'はじめに' } } },
  });
});

it('blanking both email fields drops the override', async () => {
  api.getLearningSettings.mockResolvedValue({
    ...SETTINGS, email_text: { invite: { en: { subject: 'Hello', intro: 'Intro' } } },
  });
  renderPage();
  await screen.findByLabelText('Branding line');
  await type('Subject', '');
  await type('Intro', '');
  await save();
  await waitFor(() => expect(api.putLearningSettings).toHaveBeenCalled());
  expect(api.putLearningSettings).toHaveBeenCalledWith({ email_text: {} });
});

it('rejects a subject longer than 200 characters', async () => {
  renderPage();
  await screen.findByLabelText('Branding line');
  fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'x'.repeat(201) } });
  expect(screen.getByText('Keep the subject to 200 characters.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);
});

it('discards edits back to the saved values', async () => {
  renderPage();
  await screen.findByLabelText('Branding line');
  await type('Branding line', 'Other');
  await userEvent.setup().click(screen.getByRole('button', { name: 'Discard' }));
  expect(value('Branding line')).toBe('Acme Moving');
});

it('shows the server message when the save is refused', async () => {
  api.putLearningSettings.mockRejectedValue(
    new ApiError(422, 'validation_error', { message: 'languages must include en' }));
  renderPage();
  await screen.findByLabelText('Branding line');
  await type('Branding line', 'Other');
  await save();
  expect((await screen.findByRole('alert')).textContent).toContain('languages must include en');
  expect(value('Branding line')).toBe('Other');
});

it('is read-only without learning:change', async () => {
  auth.change = false;
  renderPage();
  await screen.findByLabelText('Branding line');
  expect((screen.getByLabelText('Branding line') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText('Failed attempts before a lockout') as HTMLInputElement).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Reset to default' })).toBeNull();
});

it('offers Try again when the settings will not load', async () => {
  api.getLearningSettings.mockRejectedValueOnce(new Error('x')).mockResolvedValue(SETTINGS);
  renderPage();
  expect(await screen.findByText(/Couldn.t load the settings/)).toBeTruthy();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByLabelText('Branding line')).toBeTruthy();
});
