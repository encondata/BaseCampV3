// @vitest-environment jsdom
/**
 * components/plans/PlanModal.tsx: the shell every plan dialog uses. The
 * house header, the size bounds, focus moving in on open (first field,
 * else the dialog) and back out on close, and Escape: it closes unless a
 * control inside already handled it (a ComboBox closing its list) or a
 * write is in flight.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import PlanModal from './PlanModal';

afterEach(() => { cleanup(); });

it('renders the house header: eyebrow, h3 title, one-line description', () => {
  render(
    <PlanModal title="Plan settings" description="How this plan schedules." size="xwide" onClose={() => {}}>
      <p>Body</p>
    </PlanModal>,
  );
  const dialog = screen.getByRole('dialog', { name: 'Plan settings' });
  expect(dialog.classList.contains('pln-modal')).toBe(true);
  expect(dialog.classList.contains('pln-modal-xwide')).toBe(true);
  expect(screen.getByText('Project plan').className).toBe('eyebrow');
  expect(screen.getByRole('heading', { level: 3, name: 'Plan settings' })).not.toBeNull();
  expect(screen.getByText('How this plan schedules.').className).toBe('page-hint');
});

it('a stepped dialog’s step indicator sits between the header and the body', () => {
  render(
    <PlanModal title="Import" onClose={() => {}} steps={<div className="rgm-steps">Choose file · Review</div>}>
      <p>Body</p>
    </PlanModal>,
  );
  const card = screen.getByRole('dialog', { name: 'Import' });
  expect([...card.children].map((el) => el.className)).toEqual(['modal-head', 'rgm-steps', 'modal-body']);
});

it('moves focus to the first field of the body on open, past the Close button', () => {
  render(
    <PlanModal title="Task Information" onClose={() => {}}>
      <input aria-label="Disabled" disabled />
      <input type="hidden" />
      <input aria-label="Task Name" />
      <input aria-label="Duration" />
    </PlanModal>,
  );
  expect(document.activeElement).toBe(screen.getByLabelText('Task Name'));
});

it('passes over a ComboBox, whose list focus would open, to the next field', () => {
  render(
    <PlanModal title="Task Dependency" onClose={() => {}}>
      <input aria-label="Type" role="combobox" aria-expanded={false} />
      <input aria-label="Lag" />
    </PlanModal>,
  );
  expect(document.activeElement).toBe(screen.getByLabelText('Lag'));
});

it('focuses the dialog itself when it has no field', () => {
  render(
    <PlanModal title="Clear baseline" onClose={() => {}}
               footer={<button type="button">Clear</button>}>
      <p>The baseline goes away.</p>
    </PlanModal>,
  );
  expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Clear baseline' }));
});

it('gives focus back to what had it when the dialog closes', async () => {
  const user = userEvent.setup();
  function Host() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>Open</button>
        {open && (
          <PlanModal title="Lock schedule" onClose={() => setOpen(false)}>
            <input aria-label="Note" />
          </PlanModal>
        )}
      </>
    );
  }
  render(<Host />);
  const opener = screen.getByRole('button', { name: 'Open' });
  await user.click(opener);
  expect(document.activeElement).toBe(screen.getByLabelText('Note'));
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(opener);
});

it('Escape closes, unless something inside already handled it', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(
    <PlanModal title="Task Information" onClose={onClose}>
      {/* a ComboBox closing its open list marks Escape handled */}
      <input aria-label="Resource" onKeyDown={(e) => { if (e.key === 'Escape') e.preventDefault(); }} />
      <input aria-label="Notes" />
    </PlanModal>,
  );
  screen.getByLabelText('Resource').focus();
  await user.keyboard('{Escape}');
  expect(onClose).not.toHaveBeenCalled();
  screen.getByLabelText('Notes').focus();
  await user.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('neither Escape nor the scrim closes it while busy', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const { container } = render(
    <PlanModal title="Update project" busy onClose={onClose}><input aria-label="Status date" /></PlanModal>,
  );
  await user.keyboard('{Escape}');
  await user.click(container.querySelector('.modal-scrim') as HTMLElement);
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Close' }).hasAttribute('disabled')).toBe(true);
});

it('with tabs, focus lands in the visible panel, not a hidden one before it', () => {
  render(
    <PlanModal title="Task Information" onClose={() => {}}>
      <div role="group" hidden><input aria-label="Task Name" /></div>
      <div aria-hidden="true"><input aria-label="Duration" /></div>
      <div role="group"><textarea aria-label="Notes" /></div>
    </PlanModal>,
  );
  expect(document.activeElement).toBe(screen.getByLabelText('Notes'));
});

it('closing a dialog whose opener can’t take focus back hands it to the dialog under it', async () => {
  const user = userEvent.setup();
  let openTop: (on: boolean) => void = () => {};
  function Host() {
    const [top, setTop] = useState(false);
    openTop = setTop;
    return (
      <>
        <PlanModal title="Task Information" onClose={() => {}}>
          <input aria-label="Task Name" />
          <button type="button" disabled>OK</button>
        </PlanModal>
        {top && <PlanModal title="Confirm completion" onClose={() => setTop(false)}><p>Two subtasks</p></PlanModal>}
      </>
    );
  }
  render(<Host />);
  // OK was pressed and went busy (disabled), so the page had focus when the check opened
  (document.activeElement as HTMLElement).blur();
  act(() => openTop(true));
  expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Confirm completion' }));
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: 'Confirm completion' })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Task Information' }));
});

it('stacked dialogs: Escape closes only the one on top', async () => {
  const user = userEvent.setup();
  const under = vi.fn();
  const over = vi.fn();
  render(
    <>
      <PlanModal title="Task Information" onClose={under}><input aria-label="Task Name" /></PlanModal>
      <PlanModal title="Confirm completion" onClose={over}><p>Two subtasks</p></PlanModal>
    </>,
  );
  await user.keyboard('{Escape}');
  expect(over).toHaveBeenCalledTimes(1);
  expect(under).not.toHaveBeenCalled();
});
