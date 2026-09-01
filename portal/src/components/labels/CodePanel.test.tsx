// @vitest-environment jsdom
/**
 * CodePanel — Task 18. Debounced sample compile (500 ms) over
 * [design, codeText, sizeKey, dpiKey, languageKey], bad_design problems
 * rendered inline, and the zpl-only Labelary printer preview button that
 * degrades gracefully when Labelary is unreachable.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { LabelDesign } from '../../lib/labelModel';
import CodePanel from './CodePanel';

const api = vi.hoisted(() => ({ compileLabel: vi.fn(), previewZplRequest: vi.fn() }));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const DESIGN: LabelDesign = { size: { w: 4, h: 2 }, elements: [] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  api.compileLabel.mockResolvedValue({ code: '^XA^SAMPLE^XZ' });
});
afterEach(() => { vi.useRealTimers(); cleanup(); });

it('debounces compile and renders the sample code', async () => {
  render(<CodePanel kind="design" design={DESIGN} codeText="" sizeKey="4x2"
    dpiKey="203" languageKey="zpl" />);
  expect(api.compileLabel).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(600));
  expect(api.compileLabel).toHaveBeenCalledWith(expect.objectContaining({
    kind: 'design', mode: 'sample', size_key: '4x2', language_key: 'zpl' }));
  expect(screen.queryByText('^XA^SAMPLE^XZ')).not.toBeNull();
});

it('shows compile problems inline', async () => {
  const { ApiError } = await import('../../lib/api');
  api.compileLabel.mockRejectedValue(
    new ApiError(422, 'bad_design', { problems: ['t1: fontSizePt must be a positive number'] }));
  render(<CodePanel kind="design" design={DESIGN} codeText="" sizeKey="4x2"
    dpiKey="203" languageKey="zpl" />);
  await act(() => vi.advanceTimersByTimeAsync(600));
  expect(screen.queryByText(/t1: fontSizePt/)).not.toBeNull();
});

it('printer preview button appears for zpl only and degrades gracefully', async () => {
  api.previewZplRequest.mockRejectedValue(new Error('down'));
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:x'),
    revokeObjectURL: vi.fn() });
  const { rerender } = render(<CodePanel kind="design" design={DESIGN}
    codeText="" sizeKey="4x2" dpiKey="203" languageKey="zpl" />);
  await act(() => vi.advanceTimersByTimeAsync(600));
  fireEvent.click(screen.getByRole('button', { name: 'Printer preview' }));
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(screen.queryByText('Printer preview unavailable.')).not.toBeNull();
  rerender(<CodePanel kind="design" design={DESIGN} codeText="" sizeKey="4x2"
    dpiKey="203" languageKey="escp" />);
  expect(screen.queryByRole('button', { name: 'Printer preview' })).toBeNull();
});
