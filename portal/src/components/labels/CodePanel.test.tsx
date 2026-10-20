// @vitest-environment jsdom
/**
 * CodePanel — the code template editor's generated-code panel. Debounced
 * sample compile (500 ms) over [codeText, sizeKey, dpiKey, languageKey],
 * a compile failure shown inline, and the zpl-only Labelary printer
 * preview button that degrades gracefully when Labelary is unreachable.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import CodePanel from './CodePanel';

const api = vi.hoisted(() => ({ compileLabel: vi.fn(), previewZplRequest: vi.fn() }));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const CODE = '^XA^FD{serial_number}^FS^XZ';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  api.compileLabel.mockResolvedValue({ code: '^XA^SAMPLE^XZ' });
});
afterEach(() => { vi.useRealTimers(); cleanup(); });

it('debounces compile and renders the sample code', async () => {
  render(<CodePanel codeText={CODE} sizeKey="4x2" dpiKey="203" languageKey="zpl" />);
  expect(api.compileLabel).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(600));
  expect(api.compileLabel).toHaveBeenCalledWith(expect.objectContaining({
    kind: 'code', code: CODE, mode: 'sample', size_key: '4x2', language_key: 'zpl' }));
  expect(screen.queryByText('^XA^SAMPLE^XZ')).not.toBeNull();
});

it('shows a compile failure inline', async () => {
  api.compileLabel.mockRejectedValue(new Error('down'));
  render(<CodePanel codeText={CODE} sizeKey="4x2" dpiKey="203" languageKey="zpl" />);
  await act(() => vi.advanceTimersByTimeAsync(600));
  expect(screen.queryByText('Compile unavailable.')).not.toBeNull();
});

it('printer preview button appears for zpl only and degrades gracefully', async () => {
  api.previewZplRequest.mockRejectedValue(new Error('down'));
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:x'),
    revokeObjectURL: vi.fn() });
  const { rerender } = render(<CodePanel codeText={CODE} sizeKey="4x2" dpiKey="203" languageKey="zpl" />);
  await act(() => vi.advanceTimersByTimeAsync(600));
  fireEvent.click(screen.getByRole('button', { name: 'Printer preview' }));
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(screen.queryByText('Printer preview unavailable.')).not.toBeNull();
  rerender(<CodePanel codeText={CODE} sizeKey="4x2" dpiKey="203" languageKey="escp" />);
  expect(screen.queryByRole('button', { name: 'Printer preview' })).toBeNull();
});
