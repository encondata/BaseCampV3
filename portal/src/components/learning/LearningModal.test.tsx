// @vitest-environment jsdom
/**
 * LearningModal — StandardModal in the Learning dialogs' card size. The
 * shell's own behavior is covered in components/StandardModal.test.tsx; this
 * checks what the wrapper adds, that its props reach the shell, and the case
 * that sent Learning dialogs wrong before they shared it: Escape with a
 * ComboBox list open (Edit schedule's Send time) must close the list, not the
 * whole dialog.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ScheduleOut } from '../../lib/learning';
import ComboBox from '../ComboBox';
import LearningModal from './LearningModal';
import ScheduleModal from './ScheduleModal';

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();   // jsdom has none; ComboBox scrolls its active option
});

afterEach(cleanup);

function shell(props: Partial<React.ComponentProps<typeof LearningModal>> = {}) {
  const onClose = vi.fn();
  render(
    <LearningModal eyebrow="Learning" title="Edit schedule"
                   description="When people get their invite." onClose={onClose} {...props}>
      <p>the body</p>
    </LearningModal>,
  );
  return { onClose, dialog: screen.getByRole('dialog') };
}

it('is the standard house card at the Learning size: the shell classes plus lrn-modal', () => {
  const { dialog } = shell();
  expect(dialog.className).toBe('modal-card reports-modal-card rgm-card lrn-modal');
  expect([...dialog.classList].some((c) => c.startsWith('nm-'))).toBe(false);
});

it('appends the wide modifier and className', () => {
  const { dialog } = shell({ wide: true, className: 'lrn-preview-card' });
  expect(dialog.className)
    .toBe('modal-card reports-modal-card rgm-card lrn-modal lrn-modal-wide lrn-preview-card');
});

it('hands the header, label, body and footer to the shell', () => {
  const { dialog } = shell({ label: 'Schedule editor', footer: <button type="button">Save</button> });
  expect(dialog.getAttribute('aria-label')).toBe('Schedule editor');
  expect(dialog.querySelector('.eyebrow')?.textContent).toBe('Learning');
  expect(within(dialog).getByRole('heading', { name: 'Edit schedule' })).not.toBeNull();
  expect(dialog.querySelector('p.page-hint')?.textContent).toBe('When people get their invite.');
  expect(dialog.querySelector('.modal-body')?.textContent).toBe('the body');
  expect(within(dialog.querySelector('.modal-foot') as HTMLElement)
    .getByRole('button', { name: 'Save' })).not.toBeNull();
});

it('closes from the × button, the scrim and Escape, and is locked while busy', async () => {
  const user = userEvent.setup();
  const { onClose, dialog } = shell();
  await user.click(within(dialog).getByRole('button', { name: 'Close' }));
  fireEvent.mouseDown(dialog.closest('.modal-scrim') as HTMLElement);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(3);
  cleanup();

  const busy = shell({ busy: true });
  expect((within(busy.dialog).getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.mouseDown(busy.dialog.closest('.modal-scrim') as HTMLElement);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(busy.onClose).not.toHaveBeenCalled();
});

function WithPicker({ onClose }: { onClose: () => void }) {
  const [value, setValue] = useState('08:00');
  return (
    <LearningModal eyebrow="Learning" title="Picker" onClose={onClose}>
      <ComboBox ariaLabel="Send time" value={value} onChange={setValue}
                options={[{ value: '08:00', label: '8:00 AM' }, { value: '09:00', label: '9:00 AM' }]} />
    </LearningModal>
  );
}

it('Escape that closes an open ComboBox list does not also close the dialog', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<WithPicker onClose={onClose} />);

  await user.click(screen.getByRole('combobox', { name: 'Send time' }));
  expect(await screen.findByRole('button', { name: '9:00 AM' })).not.toBeNull();   // list is open

  await user.keyboard('{Escape}');
  expect(screen.queryByRole('button', { name: '9:00 AM' })).toBeNull();            // list closed
  expect(onClose).not.toHaveBeenCalled();                                          // dialog stays

  fireEvent.keyDown(document, { key: 'Escape' });                                  // nothing open now
  expect(onClose).toHaveBeenCalledTimes(1);
});

const SCHEDULE: ScheduleOut = {
  mode: 'scheduled', send_offset_days: 7, send_time: '08:00', reminder_offsets: [5, 3],
  due_offset_days: 2, late_adds: true, sent_at: null, send_at: null, codes_expire_on: null,
  ended: false, inactive: false, is_default: false,
};

it('Edit schedule: Escape with the Send time list open closes only the list', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<ScheduleModal initiativeId="i1" schedule={SCHEDULE} onClose={onClose} onSaved={vi.fn()} />);
  const dialog = screen.getByRole('dialog', { name: 'Edit schedule' });

  await user.click(within(dialog).getByRole('combobox', { name: 'Send time' }));
  expect(await screen.findByRole('button', { name: '9:00 AM' })).not.toBeNull();   // list is open

  await user.keyboard('{Escape}');
  expect(screen.queryByRole('button', { name: '9:00 AM' })).toBeNull();            // list closed
  expect(screen.getByRole('dialog', { name: 'Edit schedule' })).not.toBeNull();
  expect(onClose).not.toHaveBeenCalled();                                          // dialog stays

  fireEvent.keyDown(document, { key: 'Escape' });                                  // nothing open now
  expect(onClose).toHaveBeenCalledTimes(1);
});
