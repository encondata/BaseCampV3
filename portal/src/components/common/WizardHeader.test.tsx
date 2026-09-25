// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import { MOVE_SETUP_STEPS } from '../../lib/moveSetup';
import WizardHeader from './WizardHeader';

afterEach(cleanup);

it('shows the eyebrow, "Step x of 5 · title", the description, and done/current/upcoming steps', () => {
  const { container } = render(<WizardHeader steps={MOVE_SETUP_STEPS} current={2}
    title="Crates" description="Name and count the crates." />);
  expect(screen.getByText('Bulk Actions')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Step 3 of 5 · Crates' })).toBeTruthy();
  expect(screen.getByText('Name and count the crates.')).toBeTruthy();
  const items = [...container.querySelectorAll('.rgm-step')];
  expect(items.map((i) => i.classList.contains('done'))).toEqual([true, true, false, false, false]);
  expect(items[2]!.classList.contains('on')).toBe(true);
  expect(items[2]!.getAttribute('aria-current')).toBe('step');
  expect(items.map((i) => i.textContent)).toEqual(['1Move', '2Assets', '3Crates', '4Trucks', '5Review']);
});

it('marks every step done once the wizard has finished', () => {
  const { container } = render(<WizardHeader steps={MOVE_SETUP_STEPS} current={4}
    title="Review and create" description="d" allDone />);
  expect([...container.querySelectorAll('.rgm-step.done')]).toHaveLength(5);
});
