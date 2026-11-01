// @vitest-environment jsdom
/**
 * NotificationModal — StandardModal in the notification dialogs' card size.
 * The shell's own behavior (header, closing, Escape with an open ComboBox
 * list) is covered in components/StandardModal.test.tsx; this checks what the
 * wrapper adds and that its props reach the shell.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import NotificationModal from './NotificationModal';

afterEach(cleanup);

function shell(props: Partial<React.ComponentProps<typeof NotificationModal>> = {}) {
  const onClose = vi.fn();
  render(
    <NotificationModal eyebrow="Notification group" title="Edit group"
                       description="Rename the group or change its description."
                       onClose={onClose} {...props}>
      <p>the body</p>
    </NotificationModal>,
  );
  return { onClose, dialog: screen.getByRole('dialog') };
}

it('is the standard house card at the notification size: the shell classes plus nm-card', () => {
  const { dialog } = shell();
  expect(dialog.className).toBe('modal-card reports-modal-card rgm-card nm-card');
  expect(dialog.classList.contains('nm-card-wide')).toBe(false);
  // none of the Learning dialogs' classes ride along
  expect([...dialog.classList].some((c) => c.startsWith('lrn-'))).toBe(false);
});

it('appends className and the wide modifier', () => {
  const { dialog } = shell({ className: 'extra', wide: true });
  expect(dialog.className).toBe('modal-card reports-modal-card rgm-card nm-card nm-card-wide extra');
});

it('hands the header, label, body and footer to the shell', () => {
  const { dialog } = shell({ label: 'Group editor', footer: <button type="button">Save</button> });
  expect(dialog.getAttribute('aria-label')).toBe('Group editor');
  expect(dialog.querySelector('.eyebrow')?.textContent).toBe('Notification group');
  expect(within(dialog).getByRole('heading', { name: 'Edit group' })).not.toBeNull();
  expect(dialog.querySelector('p.page-hint')?.textContent)
    .toBe('Rename the group or change its description.');
  expect(dialog.querySelector('.modal-body')?.textContent).toBe('the body');
  expect(within(dialog.querySelector('.modal-foot') as HTMLElement)
    .getByRole('button', { name: 'Save' })).not.toBeNull();
});

it('closes from the × button and Escape, through onClose', async () => {
  const user = userEvent.setup();
  const { onClose, dialog } = shell();
  await user.click(within(dialog).getByRole('button', { name: 'Close' }));
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(2);
});

it('is locked while busy', () => {
  const { onClose, dialog } = shell({ busy: true });
  expect((within(dialog).getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.mouseDown(dialog.closest('.modal-scrim') as HTMLElement);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();
});
