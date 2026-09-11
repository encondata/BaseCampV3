// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';

import { ChoiceCard, InitiativeSummary } from './ReportOptionsLayout';

afterEach(() => { cleanup(); });

/** A minimal 3-card group, standing in for the real callers (Move Scan
 *  History's Format cards today; anything with 2+ choices tomorrow) —
 *  exercises the roving arrow-key behavior generically rather than only
 *  ever at the 2-card size the app currently uses. */
function ChoiceCardGroup() {
  const [value, setValue] = useState<'a' | 'b' | 'c'>('a');
  return (
    <div className="rgm-choice-cards" role="radiogroup" aria-label="Pick one">
      <ChoiceCard title="Card A" description="First choice" selected={value === 'a'}
                  onSelect={() => setValue('a')} />
      <ChoiceCard title="Card B" description="Second choice" selected={value === 'b'}
                  onSelect={() => setValue('b')} />
      <ChoiceCard title="Card C" description="Third choice" selected={value === 'c'}
                  onSelect={() => setValue('c')} />
    </div>
  );
}

it('ChoiceCard renders radio semantics: one role="radio" per card, aria-checked tracks selection, roving tabindex', () => {
  render(<ChoiceCardGroup />);
  const a = screen.getByRole('radio', { name: /Card A/ });
  const b = screen.getByRole('radio', { name: /Card B/ });
  const c = screen.getByRole('radio', { name: /Card C/ });
  expect(a.getAttribute('aria-checked')).toBe('true');
  expect(b.getAttribute('aria-checked')).toBe('false');
  expect(c.getAttribute('aria-checked')).toBe('false');
  expect(a.getAttribute('tabindex')).toBe('0');
  expect(b.getAttribute('tabindex')).toBe('-1');
  expect(c.getAttribute('tabindex')).toBe('-1');
});

it('clicking a card selects it and moves the roving tabindex', async () => {
  const user = userEvent.setup();
  render(<ChoiceCardGroup />);
  await user.click(screen.getByRole('radio', { name: /Card B/ }));
  expect(screen.getByRole('radio', { name: /Card A/ }).getAttribute('aria-checked')).toBe('false');
  expect(screen.getByRole('radio', { name: /Card B/ }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('radio', { name: /Card A/ }).getAttribute('tabindex')).toBe('-1');
  expect(screen.getByRole('radio', { name: /Card B/ }).getAttribute('tabindex')).toBe('0');
});

it('ArrowRight/ArrowDown move focus and selection to the next sibling, wrapping past the last card', async () => {
  const user = userEvent.setup();
  render(<ChoiceCardGroup />);
  screen.getByRole('radio', { name: /Card A/ }).focus();
  await user.keyboard('{ArrowRight}');
  expect(screen.getByRole('radio', { name: /Card B/ }).getAttribute('aria-checked')).toBe('true');
  expect(document.activeElement).toBe(screen.getByRole('radio', { name: /Card B/ }));
  await user.keyboard('{ArrowDown}');
  expect(screen.getByRole('radio', { name: /Card C/ }).getAttribute('aria-checked')).toBe('true');
  await user.keyboard('{ArrowRight}');   // wraps from the last card back to the first
  expect(screen.getByRole('radio', { name: /Card A/ }).getAttribute('aria-checked')).toBe('true');
  expect(document.activeElement).toBe(screen.getByRole('radio', { name: /Card A/ }));
});

it('ArrowLeft/ArrowUp move focus and selection to the previous sibling, wrapping past the first card', async () => {
  const user = userEvent.setup();
  render(<ChoiceCardGroup />);
  screen.getByRole('radio', { name: /Card A/ }).focus();
  await user.keyboard('{ArrowLeft}');   // wraps from the first card to the last
  expect(screen.getByRole('radio', { name: /Card C/ }).getAttribute('aria-checked')).toBe('true');
  expect(document.activeElement).toBe(screen.getByRole('radio', { name: /Card C/ }));
  await user.keyboard('{ArrowUp}');
  expect(screen.getByRole('radio', { name: /Card B/ }).getAttribute('aria-checked')).toBe('true');
});

it('Space/Enter select the focused card', async () => {
  const user = userEvent.setup();
  render(<ChoiceCardGroup />);
  screen.getByRole('radio', { name: /Card A/ }).focus();
  await user.keyboard('{ArrowRight}');   // focus Card B without selecting via click
  await user.keyboard(' ');
  expect(screen.getByRole('radio', { name: /Card B/ }).getAttribute('aria-checked')).toBe('true');
});

it('InitiativeSummary renders the name, client, type/status chips, scheduled dates, and source → destination', () => {
  render(
    <InitiativeSummary
      initiative={{
        name: 'NAP11 Hall Migration', clientName: 'Acme',
        typeLabel: 'Move', typeColor: '#123456',
        statusLabel: 'In progress', statusColor: '#654321',
        scheduledStart: '2026-10-01T00:00:00Z', scheduledEnd: '2026-10-05T00:00:00Z',
        originName: 'NAP11', destinationName: 'NAP22',
      }}
      emptyText="Pick an initiative to see its details here."
    />,
  );
  expect(screen.getByText('NAP11 Hall Migration')).toBeTruthy();
  expect(screen.getByText('Acme')).toBeTruthy();
  expect(screen.getByText('Move')).toBeTruthy();
  expect(screen.getByText('In progress')).toBeTruthy();
  expect(screen.getByText('NAP11 → NAP22')).toBeTruthy();
  expect(screen.queryByText('Pick an initiative to see its details here.')).toBeNull();
});

it('InitiativeSummary renders the empty copy and nothing else when initiative is null', () => {
  render(<InitiativeSummary initiative={null} emptyText="No initiative — sites chosen manually" />);
  expect(screen.getByText('No initiative — sites chosen manually')).toBeTruthy();
  expect(screen.queryByText('→')).toBeNull();
});

it('InitiativeSummary omits the chips row when neither type nor status label is given (Move Scan History\'s own preview payload)', () => {
  render(
    <InitiativeSummary
      initiative={{
        name: 'NAP11 Hall Migration', clientName: 'Acme',
        scheduledStart: '2026-10-01T00:00:00Z', originName: 'NAP11', destinationName: 'NAP22',
      }}
      emptyText="unused"
    />,
  );
  expect(screen.getByText('NAP11 Hall Migration')).toBeTruthy();
  expect(document.querySelector('.rgm-summary-chips')).toBeNull();
});
