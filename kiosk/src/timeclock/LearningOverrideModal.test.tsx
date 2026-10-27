// @vitest-environment jsdom
/** The admin override form: credentials, a code only when the portal asks
 *  for one, a reason and a scope, and plain words for every refusal. */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '../lib/api';
import LearningOverrideModal, { overrideErrorText } from './screens/LearningOverrideModal';

const submit = vi.fn();
const onBack = vi.fn();
const onDone = vi.fn();
let user: ReturnType<typeof userEvent.setup>;

function renderModal() {
  return render(<LearningOverrideModal personName="Derek" submit={submit} onBack={onBack} onDone={onDone} />);
}

async function fill(email = 'laura@example.com', password = 'hunter2hunter2') {
  await user.type(screen.getByLabelText('Admin email'), email);
  await user.type(screen.getByLabelText('Password'), password);
}
const go = () => user.click(screen.getByRole('button', { name: 'Override and clock in' }));

beforeEach(() => {
  user = userEvent.setup();
  submit.mockReset();
  submit.mockResolvedValue({ override_id: 'ovr-1' });
  onBack.mockReset();
  onDone.mockReset();
});
afterEach(cleanup);

it('has the admin fields, the reasons and the scopes, with the mockup defaults', () => {
  renderModal();
  expect(screen.getByRole('heading', { name: 'Clock Derek in' })).toBeTruthy();
  expect(screen.getByLabelText('Admin email')).toBeTruthy();
  expect((screen.getByLabelText('Password') as HTMLInputElement).type).toBe('password');
  expect(screen.queryByLabelText('2FA code')).toBeNull();
  const reasons = screen.getAllByRole('radio').map((r) => r.textContent);
  expect(reasons).toEqual([
    'Signing on break', 'Signed on paper', 'No phone', 'Other', 'This punch only', 'Rest of today',
  ]);
  expect(screen.getByRole('radio', { name: 'Signing on break' }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('radio', { name: 'This punch only' }).getAttribute('aria-checked')).toBe('true');
});

it('sends the form and hands back the override id', async () => {
  renderModal();
  await fill();
  await user.click(screen.getByRole('radio', { name: 'Signed on paper' }));
  await user.click(screen.getByRole('radio', { name: 'Rest of today' }));
  await go();
  expect(submit).toHaveBeenCalledWith({
    admin_email: 'laura@example.com', admin_password: 'hunter2hunter2',
    reason: 'signed_on_paper', scope: 'day',
  });
  await waitFor(() => expect(onDone).toHaveBeenCalledWith('ovr-1'));
});

it('asks for text with Other, and refuses to send without it', async () => {
  renderModal();
  await fill();
  await user.click(screen.getByRole('radio', { name: 'Other' }));
  await go();
  expect(submit).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toBe('Say why, in a few words.');
  await user.type(screen.getByLabelText('Why'), '  forgot phone at home ');
  await go();
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ reason: 'other', reason_text: 'forgot phone at home' }));
});

it('needs the email and password before it sends', async () => {
  renderModal();
  await go();
  expect(submit).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toBe("Enter the admin's email and password.");
});

it('asks for the 2FA code after totp_required, keeping the password, and sends it next time', async () => {
  submit.mockRejectedValueOnce(new ApiError(403, 'totp_required'));
  renderModal();
  await fill();
  await go();
  const code = await screen.findByLabelText('2FA code');
  expect(screen.getByRole('alert').textContent).toBe("Enter the 6-digit code from the admin's authenticator app.");
  expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('hunter2hunter2');
  await waitFor(() => expect(document.activeElement).toBe(code));

  await go();                                   // empty code: asked again, nothing sent
  expect(submit).toHaveBeenCalledTimes(1);
  await user.type(code, '123456');
  await go();
  expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({ totp_code: '123456' }));
  await waitFor(() => expect(onDone).toHaveBeenCalledWith('ovr-1'));
});

it.each([
  ['override_credentials_invalid', 403, "That email and password didn't work."],
  ['totp_invalid', 403, "That code didn't work."],
  ['totp_enroll_required', 403, 'This admin must set up two-factor sign-in first.'],
  ['override_rank', 403, 'Only an admin or above can override.'],
  ['totp_seed_unreadable', 409, "This admin's two-factor sign-in can't be read. Try another admin."],
  ['reason_text_required', 422, 'Say why, in a few words.'],
  ['rate_limited', 429, 'Too many tries. Wait a few minutes.'],
  ['read_only_mode', 423, 'The portal is in read-only mode. Try again shortly.'],
  ['network', 0, "Can't reach the portal. Try again."],
  ['boom', 500, 'Something went wrong. Try again.'],
])('%s reads as plain copy and leaves the form open', async (code, status, text) => {
  submit.mockRejectedValueOnce(new ApiError(status, code));
  renderModal();
  await fill();
  await go();
  expect((await screen.findByRole('alert')).textContent).toBe(text);
  expect(onDone).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: 'Override and clock in' }) as HTMLButtonElement).disabled).toBe(false);
});

it('clears a refused password but keeps the email', async () => {
  submit.mockRejectedValueOnce(new ApiError(403, 'override_credentials_invalid'));
  renderModal();
  await fill();
  await go();
  await screen.findByRole('alert');
  expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('Admin email') as HTMLInputElement).value).toBe('laura@example.com');
});

it('a double tap sends once, and the form is locked while it is in flight', async () => {
  let resolve!: (v: { override_id: string }) => void;
  submit.mockImplementation(() => new Promise((r) => { resolve = r; }));
  renderModal();
  await fill();
  await user.dblClick(screen.getByRole('button', { name: 'Override and clock in' }));
  expect(submit).toHaveBeenCalledTimes(1);
  expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText('Password') as HTMLInputElement).disabled).toBe(true);
  resolve({ override_id: 'ovr-9' });
  await waitFor(() => expect(onDone).toHaveBeenCalledWith('ovr-9'));
});

it('Back and Escape leave without sending', async () => {
  renderModal();
  await user.click(screen.getByRole('button', { name: 'Back' }));
  await user.keyboard('{Escape}');
  expect(onBack).toHaveBeenCalledTimes(2);
  expect(submit).not.toHaveBeenCalled();
});

it('maps a non-ApiError to the generic copy', () => {
  expect(overrideErrorText(new Error('x'))).toBe('Something went wrong. Try again.');
});
