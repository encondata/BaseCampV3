// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { MoveSetupDraft, StatusValue } from '../../lib/api';
import type { CratesValue } from '../../lib/moveSetup';

const api = vi.hoisted(() => ({ patchMoveSetup: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
const { default: CratesStep } = await import('./CratesStep');

const TYPES = [{ key: 'pallet', label: 'Pallet' }] as StatusValue[];
const START: CratesValue = { convention: 'CRT-SJC-DAL-xxx', count: '0', start: '1', container_type: '', tags: {} };
const withClashes = (clashes: string[]) => ({
  id: 'd1', previews: { crates: { names: [], clashes, error: null }, trucks: null },
}) as unknown as MoveSetupDraft;

function Harness({ onNext = vi.fn() }) {
  const [value, setValue] = useState<CratesValue>(START);
  return <CratesStep draft={{ id: 'd1' } as MoveSetupDraft} value={value} setValue={setValue}
                     containerTypes={TYPES} onDraft={vi.fn()} onBack={vi.fn()}
                     onSkip={vi.fn(async () => {})} onNext={onNext} />;
}

beforeEach(() => { vi.clearAllMocks(); api.patchMoveSetup.mockResolvedValue(withClashes([])); });
afterEach(cleanup);

it('previews names live and shows the rule error as a sentence', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  const count = screen.getByLabelText('Count');
  await user.clear(count);
  await user.type(count, '5');
  expect(screen.getByText('5 crates: CRT-SJC-DAL-001, CRT-SJC-DAL-002, CRT-SJC-DAL-003 … CRT-SJC-DAL-005')).toBeTruthy();
  const convention = screen.getByLabelText('Naming convention');
  await user.clear(convention);
  await user.type(convention, 'BOX-xxx');
  expect(screen.getByText("Use only one run of x's for the number.")).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
});

it('needs a crate type once the count is above zero', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.clear(screen.getByLabelText('Count'));
  await user.type(screen.getByLabelText('Count'), '2');
  expect(screen.getByText('Pick a crate type to create crates.')).toBeTruthy();
  await user.click(screen.getByPlaceholderText('Type to search types…'));
  await user.click(await screen.findByText('Pallet'));
  expect(screen.queryByText('Pick a crate type to create crates.')).toBeNull();
});

it('flags clashes from the server and blocks Next while there are any', async () => {
  const user = userEvent.setup();
  api.patchMoveSetup.mockResolvedValue(withClashes(['CRT-SJC-DAL-002']));
  const onNext = vi.fn();
  render(<Harness onNext={onNext} />);
  await user.clear(screen.getByLabelText('Count'));
  await user.type(screen.getByLabelText('Count'), '3');
  await user.click(screen.getByPlaceholderText('Type to search types…'));
  await user.click(await screen.findByText('Pallet'));
  expect(await screen.findByText('These crate names already exist: CRT-SJC-DAL-002.')).toBeTruthy();
  expect(api.patchMoveSetup).toHaveBeenLastCalledWith('d1', { crates: expect.objectContaining({
    convention: 'CRT-SJC-DAL-xxx', count: 3, start: 1, container_type: 'pallet' }) });
  expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
  expect(onNext).not.toHaveBeenCalled();
});

it('Next saves the crates and moves on when nothing clashes', async () => {
  const user = userEvent.setup();
  const onNext = vi.fn();
  render(<Harness onNext={onNext} />);
  const next = () => screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement;
  await waitFor(() => expect(next().disabled).toBe(false));      // count 0: the live save settled
  await user.click(next());
  await waitFor(() => expect(onNext).toHaveBeenCalled());
});

it('Skip waits out a live save already sent, so the skip lands last', async () => {
  const user = userEvent.setup();
  let release!: (d: MoveSetupDraft) => void;
  api.patchMoveSetup.mockImplementationOnce(() => new Promise((r) => { release = r; }));
  const onSkip = vi.fn(async () => {});
  render(<CratesStep draft={{ id: 'd1' } as MoveSetupDraft} value={START} setValue={vi.fn()}
                     containerTypes={TYPES} onDraft={vi.fn()} onBack={vi.fn()}
                     onSkip={onSkip} onNext={vi.fn()} />);
  await waitFor(() => expect(api.patchMoveSetup).toHaveBeenCalledTimes(1));   // the live save is out
  await user.click(screen.getByRole('button', { name: 'Skip this step' }));
  expect(onSkip).not.toHaveBeenCalled();
  release(withClashes([]));
  await waitFor(() => expect(onSkip).toHaveBeenCalled());
});

it('a live save answering after the step is gone never reaches the page', async () => {
  let release!: (d: MoveSetupDraft) => void;
  api.patchMoveSetup.mockImplementationOnce(() => new Promise((r) => { release = r; }));
  const onDraft = vi.fn();
  const { unmount } = render(
    <CratesStep draft={{ id: 'd1' } as MoveSetupDraft} value={START} setValue={vi.fn()}
                containerTypes={TYPES} onDraft={onDraft} onBack={vi.fn()}
                onSkip={vi.fn(async () => {})} onNext={vi.fn()} />);
  await waitFor(() => expect(api.patchMoveSetup).toHaveBeenCalledTimes(1));
  unmount();
  release(withClashes(['CRT-SJC-DAL-001']));
  await Promise.resolve();
  expect(onDraft).not.toHaveBeenCalled();
});
