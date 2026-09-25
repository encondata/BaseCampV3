// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import TimeBulkDialog from './TimeBulkDialog';

afterEach(cleanup);

function dialog(busy: boolean) {
  const onCancel = vi.fn();
  render(<TimeBulkDialog mode="approve-all" count={3} busy={busy} error=""
                         onCancel={onCancel} onConfirm={vi.fn()} />);
  return onCancel;
}

it('Escape cancels, as in the report Generate modal', () => {
  const onCancel = dialog(false);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onCancel).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(document, { key: 'Enter' });
  expect(onCancel).toHaveBeenCalledTimes(1);
});

it('Escape is ignored while the request is in flight', () => {
  const onCancel = dialog(true);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onCancel).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog')).toBeTruthy();
});
