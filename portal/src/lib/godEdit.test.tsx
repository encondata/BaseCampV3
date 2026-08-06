// @vitest-environment jsdom
/**
 * GodCell's commit() had no re-entrancy guard: type -> Enter (commit starts,
 * `patch()` in flight) -> user tabs/clicks to the next cell -> blur fires a
 * second commit(). The seed hasn't advanced yet (the first patch hasn't
 * resolved), so the unchanged-check passes and a second PATCH fires,
 * duplicating audit rows. These tests pin the fix: an in-flight ref guard
 * that blocks the second call while the first is outstanding, and releases
 * it once that patch settles so the next real edit still saves.
 */

import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import { GodCell, type GodField } from './godEdit';

interface Row { id: string; name: string; }

const gf: GodField<Row> = {
  column: 'name',
  field: 'name',
  kind: 'text',
  fromRow: (row) => row.name,
};

afterEach(cleanup);

it('Enter then an immediate blur, before the patch settles, fires exactly one PATCH', async () => {
  const user = userEvent.setup();
  let resolvePatch!: (row: Row) => void;
  const patch = vi.fn(
    () => new Promise<Row>((resolve) => { resolvePatch = resolve; }),
  );
  const onRowSaved = vi.fn();

  render(
    <GodCell
      row={{ id: 'row-1', name: 'Acme' }}
      gf={gf}
      patch={patch}
      onRowSaved={onRowSaved}
      errorMap={{}}
    />,
  );

  const input = screen.getByRole('textbox') as HTMLInputElement;
  await user.clear(input);
  await user.type(input, 'Acme Co');

  // Enter starts commit() — patch() is now in flight, awaiting resolvePatch.
  fireEvent.keyDown(input, { key: 'Enter' });
  // Before that promise settles, blur fires a second commit() with the same
  // (still-unadvanced) seed — this is the double-PATCH race.
  fireEvent.blur(input);

  expect(patch).toHaveBeenCalledTimes(1);

  resolvePatch({ id: 'row-1', name: 'Acme Co' });
  await waitFor(() => expect(onRowSaved).toHaveBeenCalledTimes(1));

  // Still exactly one call after the in-flight patch resolved and any
  // microtasks it queued have flushed.
  expect(patch).toHaveBeenCalledTimes(1);
});

function Harness({ patch, onSaved }: {
  patch: (id: string, body: Record<string, unknown>) => Promise<Row>;
  onSaved: () => void;
}) {
  const [row, setRow] = useState<Row>({ id: 'row-1', name: 'Acme' });
  return (
    <GodCell
      row={row}
      gf={gf}
      patch={patch}
      onRowSaved={(updated) => { setRow(updated); onSaved(); }}
      errorMap={{}}
    />
  );
}

it('guard resets once the patch resolves, so the next edit+Enter saves again', async () => {
  const user = userEvent.setup();
  const patch = vi.fn()
    .mockResolvedValueOnce({ id: 'row-1', name: 'Acme Co' })
    .mockResolvedValueOnce({ id: 'row-1', name: 'Acme Corp' });
  const onSaved = vi.fn();

  render(<Harness patch={patch} onSaved={onSaved} />);

  const input = screen.getByRole('textbox') as HTMLInputElement;
  await user.clear(input);
  await user.type(input, 'Acme Co');
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(patch).toHaveBeenCalledTimes(1);

  await user.clear(input);
  await user.type(input, 'Acme Corp');
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
});
