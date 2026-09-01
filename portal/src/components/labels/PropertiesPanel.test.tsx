// @vitest-environment jsdom
/**
 * PropertiesPanel — geometry + per-type fields + placeholder picker for
 * the selected label element. Pure props, no api mocks needed.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import type { LabelPlaceholder } from '../../lib/api';
import type { LabelEl } from '../../lib/labelModel';
import PropertiesPanel from './PropertiesPanel';

afterEach(cleanup);

const PH: LabelPlaceholder[] = [{ key: 'serial_number', label: 'Serial number', description: '',
  sample_value: 'C7X', applies_to: ['top'], sort_order: 1, is_active: true,
  usage_count: 0 }];
const TEXT: LabelEl = { id: 't1', type: 'text', x: 0.5, y: 0.5, w: 1.5,
  h: 0.25, rotation: 0, content: 'SN ', fontSizePt: 10, bold: false,
  align: 'left' };

it('shows a hint with no selection', () => {
  render(<PropertiesPanel element={null} placeholders={PH} labelType="top"
    onPatch={() => {}} onRemove={() => {}} />);
  expect(screen.queryByText(/Select an element/)).not.toBeNull();
});

it('edits geometry numerically', async () => {
  const onPatch = vi.fn();
  render(<PropertiesPanel element={TEXT} placeholders={PH} labelType="top"
    onPatch={onPatch} onRemove={() => {}} />);
  const x = screen.getByLabelText('X (in)') as HTMLInputElement;
  fireEvent.change(x, { target: { value: '1.2' } });
  expect(onPatch).toHaveBeenCalledWith('t1', { x: 1.2 });
});

it('inserts a placeholder token into text content', async () => {
  const onPatch = vi.fn();
  render(<PropertiesPanel element={TEXT} placeholders={PH} labelType="top"
    onPatch={onPatch} onRemove={() => {}} />);
  await userEvent.selectOptions(screen.getByLabelText('Insert variable'),
    'serial_number');
  expect(onPatch).toHaveBeenCalledWith('t1', { content: 'SN {serial_number}' });
});

it('filters the picker by label type', () => {
  render(<PropertiesPanel element={TEXT} placeholders={PH} labelType="container"
    onPatch={() => {}} onRemove={() => {}} />);
  expect(screen.queryByText(/Serial number/)).toBeNull();
});

it('per-type fields: barcode symbology patch + delete', async () => {
  const onPatch = vi.fn(); const onRemove = vi.fn();
  const BC: LabelEl = { id: 'b1', type: 'barcode', x: 0, y: 0, w: 2, h: 0.5,
    rotation: 0, symbology: 'code128', data: '{asset_id}', showText: true };
  render(<PropertiesPanel element={BC} placeholders={PH} labelType="top"
    onPatch={onPatch} onRemove={onRemove} />);
  await userEvent.selectOptions(screen.getByLabelText('Symbology'), 'code39');
  expect(onPatch).toHaveBeenCalledWith('b1', { symbology: 'code39' });
  await userEvent.click(screen.getByRole('button', { name: 'Delete element' }));
  expect(onRemove).toHaveBeenCalledWith('b1');
});
