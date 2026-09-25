// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { MoveSetupDraft, SiteItem } from '../../lib/api';
import { initialTrucks, type TrucksValue } from '../../lib/moveSetup';

const api = vi.hoisted(() => ({ patchMoveSetup: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));
const { default: TrucksStep } = await import('./TrucksStep');

const ORIGIN = { id: 's1', name: 'San Jose DC', code: 'SJC' } as SiteItem;
const DESTINATION = { id: 's2', name: 'Dallas DC', code: 'DAL' } as SiteItem;
const withClashes = (clashes: string[]) => ({
  id: 'd1', previews: { crates: null, trucks: { names: [], clashes, error: null } },
}) as unknown as MoveSetupDraft;

function Harness({ onNext = vi.fn(), onSkip = vi.fn(async () => {}), skipped = false }) {
  const [value, setValue] = useState<TrucksValue>(initialTrucks(ORIGIN, DESTINATION));
  return <TrucksStep draft={{ id: 'd1' } as MoveSetupDraft} value={value} setValue={setValue}
                     origin={ORIGIN} destination={DESTINATION} onDraft={vi.fn()} onBack={vi.fn()}
                     onSkip={onSkip} onNext={onNext} skipped={skipped} />;
}

beforeEach(() => { vi.clearAllMocks(); api.patchMoveSetup.mockResolvedValue(withClashes([])); });
afterEach(cleanup);

it('prefills the convention from the site codes and previews names live', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  expect((screen.getByLabelText('Naming convention') as HTMLInputElement).value).toBe('TRK-SJC-DAL-xxx');
  const count = screen.getByLabelText('Count');
  await user.clear(count);
  await user.type(count, '5');
  expect(screen.getByText(
    '5 trucks: TRK-SJC-DAL-001, TRK-SJC-DAL-002, TRK-SJC-DAL-003 … TRK-SJC-DAL-005')).toBeTruthy();
});

it('bounds the count between 0 and 100', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  const count = screen.getByLabelText('Count');
  await user.clear(count);
  await user.type(count, '101');
  expect(screen.getByText('The count must be between 0 and 100.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
});

it('flags clashes from the server and blocks Next while there are any', async () => {
  const user = userEvent.setup();
  api.patchMoveSetup.mockResolvedValue(withClashes(['TRK-SJC-DAL-002']));
  const onNext = vi.fn();
  render(<Harness onNext={onNext} />);
  const count = screen.getByLabelText('Count');
  await user.clear(count);
  await user.type(count, '3');
  expect(await screen.findByText('These truck names already exist: TRK-SJC-DAL-002.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
  expect(onNext).not.toHaveBeenCalled();
});

it('Next saves the trucks and moves on when nothing clashes', async () => {
  const user = userEvent.setup();
  const onNext = vi.fn();
  render(<Harness onNext={onNext} />);
  const next = () => screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement;
  await waitFor(() => expect(next().disabled).toBe(false));   // count 0: the live save settled
  await user.click(next());
  await waitFor(() => expect(onNext).toHaveBeenCalled());
});

it('Skip waits out a live save already sent, so the skip lands last', async () => {
  let release!: (d: MoveSetupDraft) => void;
  api.patchMoveSetup.mockImplementationOnce(() => new Promise((r) => { release = r; }));
  const onSkip = vi.fn(async () => {});
  const user = userEvent.setup();
  render(<Harness onSkip={onSkip} />);
  await waitFor(() => expect(api.patchMoveSetup).toHaveBeenCalledTimes(1));
  await user.click(screen.getByRole('button', { name: 'Skip this step' }));
  expect(onSkip).not.toHaveBeenCalled();
  release(withClashes([]));
  await waitFor(() => expect(onSkip).toHaveBeenCalled());
});

it('a skipped step never saves on mount, and Next moves on without saving', async () => {
  const user = userEvent.setup();
  const onNext = vi.fn();
  render(<Harness onNext={onNext} skipped />);
  expect(screen.getByText('This step is skipped. Change any field to include it.')).toBeTruthy();
  await new Promise((resolve) => { setTimeout(resolve, 600); });   // past the 400 ms save
  expect(api.patchMoveSetup).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(onNext).toHaveBeenCalled();
  expect(api.patchMoveSetup).not.toHaveBeenCalled();
});
