// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import LabelKindStep from './LabelKindStep';

afterEach(cleanup);

it('lists Top first, selected by default, with the fixed card copy', () => {
  render(<LabelKindStep selected="top" onSelect={vi.fn()} onContinue={vi.fn()} onBack={vi.fn()} />);
  expect(screen.getByText('What does this station print?')).toBeTruthy();
  const options = screen.getAllByRole('option');
  expect(options.map((o) => o.querySelector('.setup-card-title')?.textContent)).toEqual(['Top labels', 'Front labels']);
  expect(options[0].getAttribute('aria-selected')).toBe('true');
  expect(options[1].getAttribute('aria-selected')).toBe('false');
  expect(screen.getByText("4x2 today; the template's size decides")).toBeTruthy();
  expect(screen.getByText('2x1')).toBeTruthy();
});

it('selecting Front reports it, and Continue / Back call through', async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  const onContinue = vi.fn();
  const onBack = vi.fn();
  render(<LabelKindStep selected="top" onSelect={onSelect} onContinue={onContinue} onBack={onBack} />);
  await user.click(screen.getByRole('option', { name: /Front labels/ }));
  expect(onSelect).toHaveBeenCalledWith('front');
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  expect(onContinue).toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Back' }));
  expect(onBack).toHaveBeenCalled();
});
