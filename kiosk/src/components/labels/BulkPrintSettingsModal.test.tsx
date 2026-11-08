// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_PRINT_SETTINGS } from '@portal/lib/printLabels';

import BulkPrintSettingsModal from './BulkPrintSettingsModal';

afterEach(cleanup);

const setup = (over = {}) => {
  const onChange = vi.fn();
  const onClose = vi.fn();
  render(<BulkPrintSettingsModal settings={{ ...DEFAULT_PRINT_SETTINGS, ...over }} onChange={onChange} onClose={onClose} />);
  return { onChange, onClose };
};

describe('BulkPrintSettingsModal', () => {
  it('edits copies and clamps on blur', () => {
    const { onChange } = setup({ copies: 3 });
    const input = screen.getByLabelText('Copies');
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ copies: 1 }));
  });

  it('Reset is off when only offsets differ', () => {
    setup({ verticalOffset: 12 });
    expect((screen.getByText('Reset') as HTMLButtonElement).disabled).toBe(true);
  });

  it('Reset sends the defaults for the four fields', () => {
    const { onChange } = setup({ copies: 4, verticalOffset: 12 });
    fireEvent.click(screen.getByText('Reset'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ copies: DEFAULT_PRINT_SETTINGS.copies, verticalOffset: 12 }));
  });

  it('has no offset or alignment controls', () => {
    setup();
    expect(screen.queryByLabelText('Vertical offset')).toBeNull();
    expect(screen.queryByText('Print test label')).toBeNull();
  });

  it('blanks are disabled until Print by rack is on', () => {
    cleanup();
    setup({ printByRack: false });
    expect((screen.getByLabelText('Blanks between racks') as HTMLInputElement).disabled).toBe(true);
    cleanup();
    setup({ printByRack: true });
    expect((screen.getByLabelText('Blanks between racks') as HTMLInputElement).disabled).toBe(false);
  });

  it('has the report-generate header and closes on Escape and scrim', () => {
    const { onClose } = setup();
    expect(document.querySelector('.modal-card.rgm-card .rgm-head-text .eyebrow')?.textContent).toBe('Bulk Print');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(document.querySelector('.modal-scrim')!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
