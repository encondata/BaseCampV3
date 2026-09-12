// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import PrintBatchModal, { type BatchPrintState } from './PrintBatchModal';

afterEach(cleanup);

const base: BatchPrintState = {
  total: 120, batchSize: 50, currentBatch: 1, totalBatches: 3, printedCount: 0,
  printing: true, finishing: false, batchComplete: false, allComplete: false,
  autoPrintNext: false, autoCountdown: null, error: null,
};

function setup(over: Partial<BatchPrintState> = {}) {
  const handlers = {
    onAutoPrintNextChange: vi.fn(), onPrintNext: vi.fn(), onReprint: vi.fn(), onCancel: vi.fn(), onDone: vi.fn(),
  };
  render(<PrintBatchModal state={{ ...base, ...over }} subtitle="NAP11 · Top Label · 120 labels in 3 batches of 50" {...handlers} />);
  return handlers;
}

describe('PrintBatchModal', () => {
  it('shows progress, batch figures, and the sending status while printing', () => {
    setup({ printedCount: 12 });
    expect(screen.getByText('Printing labels')).toBeTruthy();
    expect(screen.getByText('12 of 120')).toBeTruthy();
    expect(screen.getByText('Printing batch 1 of 3…')).toBeTruthy();
    expect(screen.getByText('Current batch').parentElement?.textContent).toContain('1');
    expect(screen.getByText('Per batch').parentElement?.textContent).toContain('50');
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /Print next batch/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('progressbar') as HTMLElement).getAttribute('aria-valuenow')).toBe('10');
  });

  it('says it is waiting for the printer once the batch is sent', () => {
    setup({ finishing: true });
    expect(screen.getByText('Batch 1 sent - waiting for printer to finish printing…')).toBeTruthy();
  });

  it('offers next / reprint / cancel when a batch completes', async () => {
    const h = setup({ printing: false, batchComplete: true, printedCount: 50 });
    expect(screen.getByText('Batch 1 complete! Ready to print next batch.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Print next batch (50 labels)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Reprint current batch' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(h.onPrintNext).toHaveBeenCalledTimes(1);
    expect(h.onReprint).toHaveBeenCalledTimes(1);
    expect(h.onCancel).toHaveBeenCalledTimes(1);
  });

  it('labels the last batch with the remaining count and shows the countdown', () => {
    setup({ printing: false, batchComplete: true, printedCount: 100, currentBatch: 2, autoPrintNext: true, autoCountdown: 3 });
    expect(screen.getByRole('button', { name: 'Print next batch (20 labels)' })).toBeTruthy();
    expect(screen.getByText('Batch 2 complete! Next batch starts automatically in 3s… (turn off the toggle to pause)')).toBeTruthy();
  });

  it('toggles auto print next batch', async () => {
    const h = setup({ printing: false, batchComplete: true, printedCount: 50 });
    await userEvent.click(screen.getByLabelText('Auto print next batch (5 s delay)'));
    expect(h.onAutoPrintNextChange).toHaveBeenCalledWith(true);
  });

  it('shows Done only when everything printed, and hides the toggle', async () => {
    const h = setup({ printing: false, batchComplete: true, allComplete: true, printedCount: 120, currentBatch: 3 });
    expect(screen.getByText('All 120 labels printed successfully!')).toBeTruthy();
    expect(screen.queryByLabelText('Auto print next batch (5 s delay)')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(h.onDone).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('shows a batch error and ignores Escape while printing', () => {
    const h = setup({ error: 'Batch 1 failed: Printer connection lost. Please reconnect.' });
    expect(screen.getByText('Batch 1 failed: Printer connection lost. Please reconnect.')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(h.onCancel).not.toHaveBeenCalled();
  });
});
