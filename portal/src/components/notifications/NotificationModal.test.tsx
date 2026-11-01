// @vitest-environment jsdom
/**
 * NotificationModal — the one dialog shell every notification modal uses:
 * the house modal-scrim/modal-card with the report-generate header
 * (eyebrow, title, description), closing from ×, the scrim and Escape
 * unless a save is in flight.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import ComboBox from '../ComboBox';
import NotificationModal from './NotificationModal';

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();   // jsdom has none; ComboBox scrolls its active option
});

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

it('renders the standard header: eyebrow, h3 title and a page-hint description', () => {
  const { dialog } = shell();
  const head = dialog.querySelector('.modal-head .rgm-head-text') as HTMLElement;
  expect(head).not.toBeNull();
  expect(head.querySelector('.eyebrow')?.textContent).toBe('Notification group');
  expect(within(head).getByRole('heading', { level: 3 }).textContent).toBe('Edit group');
  const hint = head.querySelector('p.page-hint') as HTMLElement;
  expect(hint.textContent).toBe('Rename the group or change its description.');
  expect(within(dialog).getByRole('button', { name: 'Close' })).not.toBeNull();
});

it('is a rounded house card: modal-card + rgm-card, name from the title', () => {
  const { dialog } = shell();
  expect(dialog.classList.contains('modal-card')).toBe(true);
  expect(dialog.classList.contains('rgm-card')).toBe(true);
  expect(dialog.classList.contains('reports-modal-card')).toBe(true);
  expect(dialog.getAttribute('aria-label')).toBe('Edit group');
  expect(dialog.closest('.modal-scrim')).not.toBeNull();
  // none of the Learning dialogs' classes ride along
  expect([...dialog.classList].some((c) => c.startsWith('lrn-'))).toBe(false);
});

it('takes its accessible name from `label` when one is given', () => {
  const { dialog } = shell({ label: 'Group editor' });
  expect(dialog.getAttribute('aria-label')).toBe('Group editor');
  expect(within(dialog).getByRole('heading', { name: 'Edit group' })).not.toBeNull();
});

it('leaves the description paragraph out when there is none', () => {
  const { dialog } = shell({ description: undefined });
  expect(dialog.querySelector('p.page-hint')).toBeNull();
});

it('renders the children in the body and the footer in a modal-foot', () => {
  const { dialog } = shell({ footer: <button type="button">Save</button> });
  expect(dialog.querySelector('.modal-body')?.textContent).toBe('the body');
  const foot = dialog.querySelector('.modal-foot') as HTMLElement;
  expect(within(foot).getByRole('button', { name: 'Save' })).not.toBeNull();
  expect(foot.parentElement).toBe(dialog);   // a direct child, so the rounded-corner rule reaches it
});

it('has no footer strip when no footer is given', () => {
  const { dialog } = shell();
  expect(dialog.querySelector('.modal-foot')).toBeNull();
});

it('appends className and the wide modifier', () => {
  const { dialog } = shell({ className: 'extra', wide: true });
  expect(dialog.classList.contains('extra')).toBe(true);
  expect(dialog.classList.contains('nm-card-wide')).toBe(true);
  cleanup();
  const plain = shell().dialog;
  expect(plain.classList.contains('nm-card-wide')).toBe(false);
});

it('closes from the × button, the scrim and Escape — but not from a click inside the card', async () => {
  const user = userEvent.setup();
  const { onClose, dialog } = shell();

  await user.click(within(dialog).getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledTimes(1);

  fireEvent.mouseDown(dialog);   // inside the card
  expect(onClose).toHaveBeenCalledTimes(1);

  fireEvent.mouseDown(dialog.closest('.modal-scrim') as HTMLElement);
  expect(onClose).toHaveBeenCalledTimes(2);

  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(3);

  fireEvent.keyDown(document, { key: 'Enter' });
  expect(onClose).toHaveBeenCalledTimes(3);
});

it('ignores every way of closing while busy, and disables ×', () => {
  const { onClose, dialog } = shell({ busy: true });
  const close = within(dialog).getByRole('button', { name: 'Close' }) as HTMLButtonElement;
  expect(close.disabled).toBe(true);

  fireEvent.mouseDown(dialog.closest('.modal-scrim') as HTMLElement);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();
});

it('stops listening for Escape once it is unmounted', () => {
  const onClose = vi.fn();
  const { unmount } = render(
    <NotificationModal eyebrow="e" title="t" onClose={onClose}><p>x</p></NotificationModal>,
  );
  unmount();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();
});

function WithPicker({ onClose }: { onClose: () => void }) {
  const [value, setValue] = useState('21:00');
  return (
    <NotificationModal eyebrow="e" title="Picker" onClose={onClose}>
      <ComboBox ariaLabel="Start" value={value} onChange={setValue}
                options={[{ value: '21:00', label: '9:00 PM' }, { value: '22:00', label: '10:00 PM' }]} />
    </NotificationModal>
  );
}

it('Escape that closes an open ComboBox list does not also close the dialog', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<WithPicker onClose={onClose} />);

  const combo = screen.getByRole('combobox', { name: 'Start' });
  await user.click(combo);
  expect(await screen.findByRole('button', { name: '10:00 PM' })).not.toBeNull();   // list is open

  await user.keyboard('{Escape}');
  expect(screen.queryByRole('button', { name: '10:00 PM' })).toBeNull();            // list closed
  expect(onClose).not.toHaveBeenCalled();                                           // dialog stays

  fireEvent.keyDown(document, { key: 'Escape' });                                   // nothing open now
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('a ComboBox list inside the dialog opens outside the card, so the card cannot clip it', async () => {
  const user = userEvent.setup();
  render(<WithPicker onClose={() => {}} />);

  await user.click(screen.getByRole('combobox', { name: 'Start' }));
  const option = await screen.findByRole('button', { name: '10:00 PM' });
  expect(screen.getByRole('dialog').contains(option)).toBe(false);
});
