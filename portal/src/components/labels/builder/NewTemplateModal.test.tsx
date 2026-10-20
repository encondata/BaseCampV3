// @vitest-environment jsdom
/**
 * New template: a name, a type and a size create a builder parent (a
 * schema 2 design of that size, inactive, no samples). A custom size typed
 * in inches or millimeters is posted in inches as a size row, listed only
 * when "Save this size to the list" is on; a listed size of the same
 * dimensions is used instead of a new row.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LabelVocab } from '../../../lib/api';

const api = vi.hoisted(() => ({ createLabelTemplate: vi.fn(), createLabelVocab: vi.fn() }));
vi.mock('../../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../../lib/api')>()), ...api,
}));

const { ApiError } = await import('../../../lib/api');
const { default: NewTemplateModal, customSizeKey, toInches } = await import('./NewTemplateModal');

const row = (kind: string, key: string, label: string, meta: Record<string, unknown> = {}, sort = 0, active = true): LabelVocab => ({
  kind, key, label, description: '', meta, sort_order: sort, is_active: active, usage_count: null,
});

const VOCAB: LabelVocab[] = [
  row('type', 'top', 'Top Label', {}, 1),
  row('type', 'front', 'Front Label', {}, 2),
  row('size', '4x2', '4" x 2"', { width_in: 4, height_in: 2, has_tab: false }, 1),
  row('size', '2x1', '2" x 1"', { width_in: 2, height_in: 1, has_tab: false }, 2),
  row('size', '3x1', 'Old 3" x 1"', { width_in: 3.5, height_in: 1, has_tab: false }, 3, false),
  row('language', 'zpl', 'ZPL', { family: 'zebra' }),
];

function setup() {
  const onCreated = vi.fn();
  const onCancel = vi.fn();
  render(<NewTemplateModal vocab={VOCAB} onCreated={onCreated} onCancel={onCancel} />);
  const dialog = screen.getByRole('dialog', { name: 'New label template' });
  return { dialog, onCreated, onCancel };
}

function custom(dialog: HTMLElement, w: string, h: string, unit: 'Inches' | 'Millimeters') {
  fireEvent.click(within(dialog).getByRole('button', { name: 'Custom…' }));
  fireEvent.click(within(dialog).getByRole('button', { name: unit }));
  fireEvent.change(within(dialog).getByLabelText(/^Width/), { target: { value: w } });
  fireEvent.change(within(dialog).getByLabelText(/^Height/), { target: { value: h } });
}

beforeEach(() => {
  api.createLabelVocab.mockImplementation(async (body: Record<string, unknown>) => ({ ...body }));
  api.createLabelTemplate.mockImplementation(async (body: Record<string, unknown>) => ({ ...body, id: 'p9' }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('NewTemplateModal', () => {
  it('creates an inactive parent at a listed size', async () => {
    const { dialog, onCreated } = setup();
    expect(within(dialog).getByRole('button', { name: '4" x 2"' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(dialog).queryByRole('button', { name: 'Old 3" x 1"' })).toBeNull();
    const create = within(dialog).getByRole('button', { name: 'Create template' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: '  Vegas Destination ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '2" x 1"' }));
    fireEvent.click(create);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'p9' })));
    expect(api.createLabelVocab).not.toHaveBeenCalled();
    expect(api.createLabelTemplate).toHaveBeenCalledWith({
      name: 'Vegas Destination', label_type: 'top', size_key: '2x1', language_key: 'zpl', kind: 'design',
      design: { schema: 2, size: { w: 2, h: 1 }, splits: {}, elements: [] }, samples: {}, is_active: false,
    });
  });

  it('posts a custom size in millimeters as inches, off the list', async () => {
    const { dialog, onCreated } = setup();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Odd' } });
    custom(dialog, '76.2', '25.4', 'Millimeters');
    expect(within(dialog).getByText('3" x 1"')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create template' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    // 3x1 is taken by an inactive row of another size, so the key moves on
    expect(api.createLabelVocab).toHaveBeenCalledWith({
      kind: 'size', key: '3x1-2', label: '3" x 1"', is_active: false,
      meta: { width_in: 3, height_in: 1, has_tab: false },
    });
    expect(api.createLabelTemplate).toHaveBeenCalledWith(expect.objectContaining({
      size_key: '3x1-2', design: { schema: 2, size: { w: 3, h: 1 }, splits: {}, elements: [] },
    }));
  });

  it('saves a custom size to the list when asked', async () => {
    const { dialog } = setup();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Odd' } });
    custom(dialog, '3.25', '1.5', 'Inches');
    fireEvent.click(within(dialog).getByLabelText('Save this size to the list'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create template' }));
    await waitFor(() => expect(api.createLabelTemplate).toHaveBeenCalled());
    expect(api.createLabelVocab).toHaveBeenCalledWith({
      kind: 'size', key: '3_25x1_5', label: '3.25" x 1.5"', is_active: true,
      meta: { width_in: 3.25, height_in: 1.5, has_tab: false },
    });
  });

  it('uses a listed size of the same dimensions', async () => {
    const { dialog } = setup();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Same' } });
    custom(dialog, '101.6', '50.8', 'Millimeters');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create template' }));
    await waitFor(() => expect(api.createLabelTemplate).toHaveBeenCalled());
    expect(api.createLabelVocab).not.toHaveBeenCalled();
    expect(api.createLabelTemplate.mock.calls[0][0].size_key).toBe('4x2');
  });

  it('needs a positive width and height', () => {
    const { dialog } = setup();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Odd' } });
    custom(dialog, '0', '2', 'Inches');
    expect((within(dialog).getByRole('button', { name: 'Create template' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says why a create failed', async () => {
    api.createLabelTemplate.mockRejectedValue(new ApiError(409, 'label_template_exists'));
    const { dialog, onCreated } = setup();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Vegas Destination' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create template' }));
    expect((await within(dialog).findByRole('alert')).textContent)
      .toBe('A template, or one of its DPI versions, already has that name.');
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('closes on Cancel and on Escape', () => {
    const { dialog, onCancel } = setup();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});

describe('custom size helpers', () => {
  it('turn millimeters into inches to the thousandth', () => {
    expect(toInches('76.2', 'mm')).toBe(3);
    expect(toInches('50', 'mm')).toBe(1.969);
    expect(toInches('2.125', 'in')).toBe(2.125);
    expect(toInches('', 'in')).toBeNull();
    expect(toInches('-1', 'in')).toBeNull();
    expect(toInches('abc', 'mm')).toBeNull();
  });

  it('name a size row like the seeded ones', () => {
    expect(customSizeKey(3.25, 1.5, new Set())).toBe('3_25x1_5');
    expect(customSizeKey(3, 1, new Set(['3x1', '3x1-2']))).toBe('3x1-3');
  });
});
