// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import BulkPrintBatchModal, { type BatchPrintState } from './BulkPrintBatchModal';

afterEach(cleanup);

const base: BatchPrintState = {
  total: 3, batchSize: 1, currentBatch: 1, totalBatches: 3, printedCount: 0, printing: false,
  finishing: false, batchComplete: false, allComplete: false, autoPrintNext: true, autoCountdown: null, error: null,
};

const setup = (over: Partial<BatchPrintState> = {}) => {
  const h = { onAutoPrintNextChange: vi.fn(), onPrintNext: vi.fn(), onReprint: vi.fn(), onCancel: vi.fn(), onDone: vi.fn() };
  render(<BulkPrintBatchModal state={{ ...base, ...over }} subtitle="sub" {...h} />);
  return h;
};

describe('BulkPrintBatchModal', () => {
  it('shows progress and the waiting line', () => {
    setup({ printedCount: 1, printing: true, finishing: true });
    expect(screen.getByText('1 of 3')).toBeTruthy();
    expect(screen.getByText('Batch 1 sent - waiting for printer to finish printing…')).toBeTruthy();
  });

  it('shows the countdown', () => {
    setup({ batchComplete: true, autoCountdown: 4 });
    expect(screen.getByText('Batch 1 complete! Next batch starts automatically in 4s… (turn off the toggle to pause)')).toBeTruthy();
  });

  it('failed state offers Reprint, not Print next', () => {
    setup({ batchComplete: true, error: 'Batch 1 failed: x' });
    expect(screen.getByText('Batch 1 failed: x')).toBeTruthy();
    expect((screen.getByText('Reprint current batch') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByText(/Print next batch \(/) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Escape cancels only between batches', () => {
    cleanup();
    let h = setup({ printing: true });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(h.onCancel).not.toHaveBeenCalled();
    cleanup();
    h = setup({ batchComplete: true });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(h.onCancel).toHaveBeenCalledTimes(1);
  });

  it('both modals have the report-generate header', () => {
    setup();
    expect(document.querySelector('.modal-card.rgm-card .rgm-head-text .eyebrow')?.textContent).toBe('Bulk Print');
  });

  it('toggles auto print with the kiosk Switch', () => {
    const h = setup();
    fireEvent.click(screen.getByRole('switch'));
    expect(h.onAutoPrintNextChange).toHaveBeenCalledWith(false);
  });
});
