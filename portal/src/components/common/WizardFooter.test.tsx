// @vitest-environment jsdom
/** WizardFooter — Back / Skip / hint / error, an optional secondary action, and the primary Next. */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import WizardFooter from './WizardFooter';

afterEach(cleanup);

it('renders Back, Skip and the primary, with the primary carrying the right-side margin', async () => {
  const onBack = vi.fn(); const onNext = vi.fn();
  render(<WizardFooter onBack={onBack} onSkip={() => undefined} onNext={onNext} />);
  await userEvent.click(screen.getByRole('button', { name: 'Back' }));
  await userEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect(onBack).toHaveBeenCalledTimes(1);
  expect(onNext).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Next' }).className).toBe('btn-solid wiz-next');
  expect(screen.getByRole('button', { name: 'Skip this step' })).toBeTruthy();
});

it('renders a secondary action immediately left of the primary, both on the right', async () => {
  const onClick = vi.fn();
  render(<WizardFooter onBack={() => undefined} onNext={() => undefined} nextLabel="Done"
                       secondary={{ label: 'Import into a move', onClick }} />);
  const buttons = screen.getAllByRole('button').map((b) => b.textContent);
  expect(buttons).toEqual(['Back', 'Import into a move', 'Done']);
  const secondary = screen.getByRole('button', { name: 'Import into a move' });
  const primary = screen.getByRole('button', { name: 'Done' });
  expect(secondary.nextElementSibling).toBe(primary);
  // the secondary takes the auto margin so the pair sits right; Back stays left
  expect(secondary.className).toBe('mini-btn wiz-next');
  expect(primary.className).toBe('btn-solid');
  expect(screen.getByRole('button', { name: 'Back' }).className).toBe('mini-btn');
  await userEvent.click(secondary);
  expect(onClick).toHaveBeenCalledTimes(1);
});

it('disables the secondary when it says so, and while busy', () => {
  const { rerender } = render(<WizardFooter onNext={() => undefined}
    secondary={{ label: 'Extra', onClick: () => undefined, disabled: true }} />);
  expect((screen.getByRole('button', { name: 'Extra' }) as HTMLButtonElement).disabled).toBe(true);
  rerender(<WizardFooter onNext={() => undefined} busy
    secondary={{ label: 'Extra', onClick: () => undefined }} />);
  expect((screen.getByRole('button', { name: 'Extra' }) as HTMLButtonElement).disabled).toBe(true);
  rerender(<WizardFooter onNext={() => undefined}
    secondary={{ label: 'Extra', onClick: () => undefined }} />);
  expect((screen.getByRole('button', { name: 'Extra' }) as HTMLButtonElement).disabled).toBe(false);
});
