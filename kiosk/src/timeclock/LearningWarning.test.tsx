// @vitest-environment jsdom
/** The warning before a clock-in: what is outstanding, and the three ways on. */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import type { KioskLearningBlock, KioskTimeclockPerson } from '../lib/api';
import LearningWarning, { type LearningWarningProps } from './screens/LearningWarning';

const PERSON: KioskTimeclockPerson = {
  id: 'p-1', display_name: 'Derek Hill', first_name: 'Derek', last_name: 'Hill', preferred_name: null,
  avatar_url: null, rfid_tag: null, job_title: null, external_id: null,
};
const TWO: KioskLearningBlock = {
  outstanding: [
    { title: 'Acme NDA', kind: 'required' },
    { title: 'Forklift safety', kind: 'extra' },
  ],
  link_email: true,
};

function props(over: Partial<LearningWarningProps> = {}): LearningWarningProps {
  return {
    person: PERSON, learning: TWO, busy: false, error: null, linkSent: false, linkSending: false,
    linkError: null, onEmail: vi.fn(), onCancel: vi.fn(), onOverride: vi.fn(), onRetry: vi.fn(), ...over,
  };
}

afterEach(cleanup);

it('names the person, counts the items and labels each one', () => {
  render(<LearningWarning {...props()} />);
  expect(screen.getByText('Derek Hill')).toBeTruthy();
  expect(screen.getByText('DH')).toBeTruthy();
  expect(screen.getByRole('heading', { name: "2 required items aren't signed yet" })).toBeTruthy();
  const rows = screen.getAllByRole('listitem').map((li) => li.textContent);
  expect(rows).toEqual(['Acme NDARequired for this move', 'Forklift safetyExtra']);
  expect(screen.getByText('You can finish them on your phone in a few minutes.')).toBeTruthy();
});

it('says "item" for exactly one', () => {
  render(<LearningWarning {...props({ learning: { ...TWO, outstanding: [TWO.outstanding[0]] } })} />);
  expect(screen.getByRole('heading', { name: "1 required item isn't signed yet" })).toBeTruthy();
});

it('offers Email me the link, Cancel punch and Admin override, each calling its handler', async () => {
  const p = props();
  render(<LearningWarning {...p} />);
  await userEvent.click(screen.getByRole('button', { name: /Email me the link/ }));
  await userEvent.click(screen.getByRole('button', { name: /Cancel punch/ }));
  await userEvent.click(screen.getByRole('button', { name: /Admin override/ }));
  expect(p.onEmail).toHaveBeenCalledTimes(1);
  expect(p.onCancel).toHaveBeenCalledTimes(1);
  expect(p.onOverride).toHaveBeenCalledTimes(1);
});

it('hides Email me the link when the person has no address', () => {
  render(<LearningWarning {...props({ learning: { ...TWO, link_email: false } })} />);
  expect(screen.queryByRole('button', { name: /Email me the link/ })).toBeNull();
  expect(screen.getByRole('button', { name: /Cancel punch/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: /Admin override/ })).toBeTruthy();
});

it('after sending it says so instead of offering the button again', () => {
  render(<LearningWarning {...props({ linkSent: true })} />);
  expect(screen.queryByRole('button', { name: /Email me the link/ })).toBeNull();
  expect(within(screen.getByRole('status')).getByText('Link sent to your email')).toBeTruthy();
});

it('disables the buttons while a punch is in flight, and shows a failed punch with Try again', async () => {
  const p = props({ busy: true, error: 'Something went wrong. Your punch was not recorded. Try again.' });
  render(<LearningWarning {...p} />);
  for (const name of [/Email me the link/, /Cancel punch/, /Admin override/, /Try again/]) {
    expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
  }
  expect(screen.getByText(/Your punch was not recorded/)).toBeTruthy();
});

it('shows why the link did not go out', () => {
  render(<LearningWarning {...props({ linkError: 'Too many tries. Wait a few minutes.' })} />);
  expect(screen.getByRole('alert').textContent).toBe('Too many tries. Wait a few minutes.');
});
