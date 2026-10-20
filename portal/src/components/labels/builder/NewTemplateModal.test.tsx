// @vitest-environment jsdom
/**
 * New template: a name, a type and a size create a builder parent (a
 * schema 2 design of that size, inactive, no samples). A custom size typed
 * in inches or millimeters is posted in inches as a size row, listed only
 * when "Save this size to the list" is on; a listed size of the same
 * dimensions is used instead of a new row. A retry after a failed create
 * rewrites the dialog's own pending row (off the list, unused) rather than
 * leaving it behind.
 *
 * The label type has Custom… too: a type name whose key is its slug, a type
 * row posted off the list unless "Save this type to the list" is on, the
 * same rewrite of its own pending row on a retry, and a name that matches
 * a listed type offers that type instead.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LabelVocab } from '../../../lib/api';

const api = vi.hoisted(() => ({ createLabelTemplate: vi.fn(), createLabelVocab: vi.fn(), updateLabelVocab: vi.fn() }));
vi.mock('../../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../../lib/api')>()), ...api,
}));

const { ApiError } = await import('../../../lib/api');
const { default: NewTemplateModal, customSizeKey, customTypeKey, toInches } = await import('./NewTemplateModal');

const row = (kind: string, key: string, label: string, meta: Record<string, unknown> = {}, sort = 0, active = true): LabelVocab => ({
  kind, key, label, description: '', meta, sort_order: sort, is_active: active, usage_count: null,
});

const VOCAB: LabelVocab[] = [
  row('type', 'top', 'Top Label', {}, 1),
  row('type', 'front', 'Front Label', {}, 2),
  row('type', 'shelf', 'Shelf (off the list)', {}, 3, false),
  row('type', 'id_badge', 'ID Badge', {}, 6),
  row('size', '4x2', '4" x 2"', { width_in: 4, height_in: 2, has_tab: false }, 1),
  row('size', '2x1', '2" x 1"', { width_in: 2, height_in: 1, has_tab: false }, 2),
  row('size', 'id-badge', 'ID Badge', { width_in: 3.375, height_in: 2.125, has_tab: false }, 6),
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
  api.updateLabelVocab.mockImplementation(async (kind: string, key: string, body: Record<string, unknown>) => (
    { kind, key, ...body }));
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

describe('a retry after a failed create', () => {
  it('reuses the custom size row it already made', async () => {
    api.createLabelTemplate.mockRejectedValueOnce(new ApiError(409, 'label_template_exists'));
    const { dialog, onCreated } = setup();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Vegas Destination' } });
    custom(dialog, '3.25', '1.5', 'Inches');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create template' }));
    expect((await within(dialog).findByRole('alert')).textContent)
      .toBe('A template, or one of its DPI versions, already has that name.');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Vegas Destination 2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create template' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(api.createLabelVocab).toHaveBeenCalledTimes(1);
    expect(api.createLabelTemplate).toHaveBeenCalledTimes(2);
    expect(api.createLabelTemplate.mock.calls[1][0]).toMatchObject({ name: 'Vegas Destination 2', size_key: '3_25x1_5' });
  });

  it('takes a 409 on its own size row, after a lost answer, as made', async () => {
    api.createLabelVocab.mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new ApiError(409, 'label_vocab_exists'));
    const { dialog, onCreated } = setup();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Odd' } });
    custom(dialog, '3.25', '1.5', 'Inches');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create template' }));
    await within(dialog).findByRole('alert');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create template' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(api.createLabelVocab.mock.calls.map((c) => c[0].key)).toEqual(['3_25x1_5', '3_25x1_5']);
    expect(api.createLabelTemplate.mock.calls[0][0].size_key).toBe('3_25x1_5');
  });

  /** A custom 3.25" x 1.5" whose first create fails on the name. */
  async function failedOnce(listed = false) {
    api.createLabelTemplate.mockRejectedValueOnce(new ApiError(409, 'label_template_exists'));
    const utils = setup();
    fireEvent.change(within(utils.dialog).getByLabelText('Name'), { target: { value: 'Odd' } });
    custom(utils.dialog, '3.25', '1.5', 'Inches');
    if (listed) fireEvent.click(within(utils.dialog).getByLabelText('Save this size to the list'));
    fireEvent.click(within(utils.dialog).getByRole('button', { name: 'Create template' }));
    await within(utils.dialog).findByRole('alert');
    return utils;
  }

  it('rewrites its own pending row when the size changed, instead of leaving it and posting another', async () => {
    const { dialog, onCreated } = await failedOnce();
    fireEvent.change(within(dialog).getByLabelText(/^Width/), { target: { value: '3.5' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create template' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(api.createLabelVocab).toHaveBeenCalledTimes(1);
    expect(api.updateLabelVocab).toHaveBeenCalledWith('size', '3_25x1_5', {
      label: '3.5" x 1.5"', is_active: false, meta: { width_in: 3.5, height_in: 1.5, has_tab: false },
    });
    expect(api.createLabelTemplate.mock.calls[1][0]).toMatchObject({
      size_key: '3_25x1_5', design: { schema: 2, size: { w: 3.5, h: 1.5 }, splits: {}, elements: [] },
    });
  });

  it('puts its own pending row on the list when the switch is turned on', async () => {
    const { dialog, onCreated } = await failedOnce();
    fireEvent.click(within(dialog).getByLabelText('Save this size to the list'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create template' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(api.createLabelVocab).toHaveBeenCalledTimes(1);
    expect(api.updateLabelVocab).toHaveBeenCalledWith('size', '3_25x1_5', {
      label: '3.25" x 1.5"', is_active: true, meta: { width_in: 3.25, height_in: 1.5, has_tab: false },
    });
    expect(api.createLabelTemplate.mock.calls[1][0].size_key).toBe('3_25x1_5');
  });

  it('leaves a size it put on the list there, and posts a new row for a changed size', async () => {
    // a listed size isn't pending: it stays for the next template, and a
    // designer can't rewrite it
    const { dialog, onCreated } = await failedOnce(true);
    fireEvent.change(within(dialog).getByLabelText(/^Width/), { target: { value: '3.5' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create template' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(api.updateLabelVocab).not.toHaveBeenCalled();
    expect(api.createLabelVocab.mock.calls.map((c) => [c[0].key, c[0].is_active]))
      .toEqual([['3_25x1_5', true], ['3_5x1_5', true]]);
  });

  it('posts a new row when its pending one can no longer be rewritten', async () => {
    api.updateLabelVocab.mockRejectedValueOnce(new ApiError(403, 'forbidden'));
    const { dialog, onCreated } = await failedOnce();
    fireEvent.change(within(dialog).getByLabelText(/^Width/), { target: { value: '3.5' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create template' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(api.updateLabelVocab).toHaveBeenCalledTimes(1);
    expect(api.createLabelVocab.mock.calls.map((c) => c[0].key)).toEqual(['3_25x1_5', '3_5x1_5']);
    expect(api.createLabelTemplate.mock.calls[1][0].size_key).toBe('3_5x1_5');
  });

  it('a lost answer to the rewrite rewrites again on the next try', async () => {
    api.updateLabelVocab.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { dialog, onCreated } = await failedOnce();
    fireEvent.change(within(dialog).getByLabelText(/^Width/), { target: { value: '3.5' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create template' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe("Couldn't create the template.");
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create template' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(api.createLabelVocab).toHaveBeenCalledTimes(1);
    expect(api.updateLabelVocab.mock.calls.map((c) => c[1])).toEqual(['3_25x1_5', '3_25x1_5']);
    expect(api.createLabelTemplate.mock.calls.at(-1)![0].size_key).toBe('3_25x1_5');
  });

  it('a size row someone else just made moves the next try to a new key', async () => {
    api.createLabelVocab.mockRejectedValueOnce(new ApiError(409, 'label_vocab_exists'));
    const { dialog, onCreated } = setup();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Odd' } });
    custom(dialog, '3.25', '1.5', 'Inches');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create template' }));
    expect((await within(dialog).findByRole('alert')).textContent)
      .toBe('Someone added a size under the same name just now. Press Create template again.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create template' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(api.createLabelVocab.mock.calls.map((c) => c[0].key)).toEqual(['3_25x1_5', '3_25x1_5-2']);
  });
});

/** Picks Custom… in the label type box and types the type's name. */
function customType(dialog: HTMLElement, name: string) {
  fireEvent.focus(within(dialog).getByLabelText('Label type'));
  const menu = document.querySelector('.combo-menu') as HTMLElement;
  fireEvent.mouseDown(within(menu).getByText('Custom…'));
  fireEvent.change(within(dialog).getByLabelText('Type name'), { target: { value: name } });
}

const NOTE = "Custom types print from the portal's Print Labels once they're on the list; kiosk Label Stations "
  + 'print Top and Front labels.';
const OFF_LIST = 'Off the list, this type is for test prints only; save it to the list to generate labels with it.';

describe('a custom label type', () => {
  it('saves a custom type to the list by default and creates the template with it', async () => {
    const { dialog, onCreated } = setup();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Aisle shelf' } });
    expect(within(dialog).queryByText(NOTE)).toBeNull();
    customType(dialog, '  Shelf tag ');
    expect(within(dialog).getByText(NOTE)).toBeTruthy();
    expect((within(dialog).getByLabelText('Type name') as HTMLInputElement).placeholder).toBe('Shelf tag');
    expect((within(dialog).getByLabelText('Save this type to the list') as HTMLInputElement).checked).toBe(true);
    expect(within(dialog).queryByText(OFF_LIST)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create template' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(api.createLabelVocab).toHaveBeenCalledWith({ kind: 'type', key: 'shelf_tag', label: 'Shelf tag', is_active: true });
    expect(api.createLabelTemplate).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Aisle shelf', label_type: 'shelf_tag', size_key: '4x2' }));
  });

  it('off the list it says the type is for test prints only, and posts it off the list', async () => {
    const { dialog } = setup();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Aisle shelf' } });
    customType(dialog, 'Shelf tag');
    fireEvent.click(within(dialog).getByLabelText('Save this type to the list'));
    expect(within(dialog).getByText(OFF_LIST)).toBeTruthy();
    expect(within(dialog).getByText(NOTE)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create template' }));
    await waitFor(() => expect(api.createLabelTemplate).toHaveBeenCalled());
    expect(api.createLabelVocab).toHaveBeenCalledWith({ kind: 'type', key: 'shelf_tag', label: 'Shelf tag', is_active: false });
    // back on: the line goes
    fireEvent.click(within(dialog).getByLabelText('Save this type to the list'));
    expect(within(dialog).queryByText(OFF_LIST)).toBeNull();
  });

  it('needs a type name', () => {
    const { dialog } = setup();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Aisle shelf' } });
    customType(dialog, '  ');
    expect((within(dialog).getByRole('button', { name: 'Create template' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a name that is a listed type says so and offers it instead', () => {
    const { dialog } = setup();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Front tag' } });
    customType(dialog, 'Front');
    expect(within(dialog).getByText('That type already exists.')).toBeTruthy();
    const create = within(dialog).getByRole('button', { name: 'Create template' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    // its label matches too, whatever the case
    fireEvent.change(within(dialog).getByLabelText('Type name'), { target: { value: 'front label' } });
    expect(within(dialog).getByText('That type already exists.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use Front Label' }));
    expect(within(dialog).queryByLabelText('Type name')).toBeNull();
    expect((within(dialog).getByLabelText('Label type') as HTMLInputElement).value).toBe('Front Label');
    expect(create.disabled).toBe(false);
  });

  it('a key an unlisted type holds moves on to the next free one', async () => {
    const { dialog } = setup();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Shelf tag' } });
    customType(dialog, 'Shelf');
    expect(within(dialog).queryByText('That type already exists.')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create template' }));
    await waitFor(() => expect(api.createLabelTemplate).toHaveBeenCalled());
    expect(api.createLabelVocab.mock.calls[0][0]).toMatchObject({ kind: 'type', key: 'shelf_2', label: 'Shelf' });
  });

  it('a retry with a changed type rewrites its own pending row', async () => {
    api.createLabelTemplate.mockRejectedValueOnce(new ApiError(409, 'label_template_exists'));
    const { dialog, onCreated } = setup();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Aisle shelf' } });
    customType(dialog, 'Shelf tag');
    fireEvent.click(within(dialog).getByLabelText('Save this type to the list'));   // off the list
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create template' }));
    await within(dialog).findByRole('alert');
    fireEvent.change(within(dialog).getByLabelText('Type name'), { target: { value: 'Bin tag' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create template' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(api.createLabelVocab).toHaveBeenCalledTimes(1);
    expect(api.updateLabelVocab).toHaveBeenCalledWith('type', 'shelf_tag', { label: 'Bin tag', is_active: false });
    expect(api.createLabelTemplate.mock.calls[1][0].label_type).toBe('shelf_tag');
  });

  it('a retry with the same type reuses its row; the switch puts it on the list', async () => {
    api.createLabelTemplate.mockRejectedValueOnce(new ApiError(409, 'label_template_exists'))
      .mockRejectedValueOnce(new ApiError(409, 'label_template_exists'));
    const { dialog, onCreated } = setup();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Aisle shelf' } });
    customType(dialog, 'Shelf tag');
    fireEvent.click(within(dialog).getByLabelText('Save this type to the list'));   // off the list
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create template' }));
    await within(dialog).findByRole('alert');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create template' }));
    await waitFor(() => expect(api.createLabelTemplate).toHaveBeenCalledTimes(2));
    expect(api.createLabelVocab).toHaveBeenCalledTimes(1);
    expect(api.updateLabelVocab).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByLabelText('Save this type to the list'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create template' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(api.updateLabelVocab).toHaveBeenCalledWith('type', 'shelf_tag', { label: 'Shelf tag', is_active: true });
  });

  it('a type row someone else just made says so', async () => {
    api.createLabelVocab.mockRejectedValueOnce(new ApiError(409, 'label_vocab_exists'));
    const { dialog } = setup();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Aisle shelf' } });
    customType(dialog, 'Shelf tag');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create template' }));
    expect((await within(dialog).findByRole('alert')).textContent)
      .toBe('Someone added a type under the same name just now. Press Create template again.');
  });

  it('type keys are lowercase slugs, moved on when taken', () => {
    expect(customTypeKey('Shelf tag', new Set())).toBe('shelf_tag');
    expect(customTypeKey('  Café   Tag #2 ', new Set())).toBe('cafe_tag_2');
    expect(customTypeKey('Shelf tag', new Set(['shelf_tag', 'shelf_tag_2']))).toBe('shelf_tag_3');
    expect(customTypeKey('!!!', new Set())).toBe('');
    expect(customTypeKey('x'.repeat(60), new Set()).length).toBeLessThanOrEqual(36);
  });
});

describe('the ID Badge type', () => {
  /** Picks a listed type in the label type box. */
  function pickType(dialog: HTMLElement, label: string) {
    fireEvent.focus(within(dialog).getByLabelText('Label type'));
    const menu = document.querySelector('.combo-menu') as HTMLElement;
    fireEvent.mouseDown(within(menu).getByText(label));
  }
  const pressed = (dialog: HTMLElement, name: string) => (
    within(dialog).getByRole('button', { name }).getAttribute('aria-pressed'));

  it('choosing ID Badge picks the ID badge size; another type leaves the size alone', async () => {
    const { dialog, onCreated } = setup();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Crew badge' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '2" x 1"' }));
    pickType(dialog, 'Front Label');
    expect(pressed(dialog, '2" x 1"')).toBe('true');
    pickType(dialog, 'ID Badge');
    expect(pressed(dialog, 'ID Badge')).toBe('true');
    expect(pressed(dialog, '2" x 1"')).toBe('false');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create template' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(api.createLabelTemplate).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Crew badge', label_type: 'id_badge', size_key: 'id-badge' }));
    expect(api.createLabelTemplate.mock.calls[0][0].design.size).toEqual({ w: 3.375, h: 2.125 });
    expect(api.createLabelVocab).not.toHaveBeenCalled();
  });

  it('a custom type named ID Badge offers the built-in type, and its size with it', () => {
    const { dialog } = setup();
    customType(dialog, 'id badge');
    expect(within(dialog).getByText('That type already exists.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use ID Badge' }));
    expect((within(dialog).getByLabelText('Label type') as HTMLInputElement).value).toBe('ID Badge');
    expect(pressed(dialog, 'ID Badge')).toBe('true');
  });
});
