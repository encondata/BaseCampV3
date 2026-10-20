// @vitest-environment jsdom
/**
 * ReplaceTemplateModal (spec §4.1, §4.11): the active templates of the same
 * family and type that a new template takes over from, all checked; Replace
 * turns them off and the new one on in one call.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError, type LabelTemplate, type LabelTemplateTreeNode } from '../../lib/api';

const api = vi.hoisted(() => ({ replaceLabelTemplates: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));

const { default: ReplaceTemplateModal } = await import('./ReplaceTemplateModal');

const NEW: LabelTemplate = {
  id: 'p2', name: 'Amsterdam Destination', description: '', label_type: 'top', size_key: '4x2', dpi_key: '300',
  language_key: 'zpl', kind: 'design', design: { schema: 2 }, code: null, version: 2, is_active: false,
  site_ids: [], created_at: '', updated_at: '', parent_id: null, schema_version: 2, dpis: ['203', '300'],
};

const legacy = (id: string, dpi: string): LabelTemplateTreeNode => ({
  ...NEW, id, name: `Amsterdam Destination - ${dpi}DPI`, kind: 'code', design: null, code: '^XA^XZ',
  schema_version: 1, dpi_key: dpi, version: 4, is_active: true, dpis: [],
  family: 'Amsterdam Destination', children: [],
});

const OLD = [legacy('l1', '203'), legacy('l2', '300')];

beforeEach(() => {
  vi.clearAllMocks();
  api.replaceLabelTemplates.mockResolvedValue({ ...NEW, is_active: true });
});

afterEach(cleanup);

it('lists the templates it takes over from, all checked', () => {
  render(<ReplaceTemplateModal template={NEW} candidates={OLD} onReplaced={vi.fn()} onClose={vi.fn()} />);
  expect(screen.getByRole('heading', { name: 'Replace with “Amsterdam Destination”' })).toBeTruthy();
  for (const row of OLD) {
    expect(screen.getByText(row.name)).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: `Turn off ${row.name}` }) as HTMLInputElement).checked).toBe(true);
  }
});

it('Replace sends the checked templates to /replace', async () => {
  const onReplaced = vi.fn();
  render(<ReplaceTemplateModal template={NEW} candidates={OLD} onReplaced={onReplaced} onClose={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: 'Replace' }));
  await waitFor(() => expect(onReplaced).toHaveBeenCalled());
  expect(api.replaceLabelTemplates).toHaveBeenCalledWith('p2', ['l1', 'l2']);
});

it('an unchecked template stays as it is', async () => {
  render(<ReplaceTemplateModal template={NEW} candidates={OLD} onReplaced={vi.fn()} onClose={vi.fn()} />);
  await userEvent.click(screen.getByRole('checkbox', { name: 'Turn off Amsterdam Destination - 300DPI' }));
  await userEvent.click(screen.getByRole('button', { name: 'Replace' }));
  await waitFor(() => expect(api.replaceLabelTemplates).toHaveBeenCalledWith('p2', ['l1']));
});

it('Replace needs at least one template checked', async () => {
  render(<ReplaceTemplateModal template={NEW} candidates={OLD} onReplaced={vi.fn()} onClose={vi.fn()} />);
  for (const row of OLD) await userEvent.click(screen.getByRole('checkbox', { name: `Turn off ${row.name}` }));
  expect((screen.getByRole('button', { name: 'Replace' }) as HTMLButtonElement).disabled).toBe(true);
});

it('names what is still in the way when the swap is refused', async () => {
  api.replaceLabelTemplates.mockRejectedValue(
    new ApiError(422, 'active_conflict', { code: 'active_conflict', names: ['Amsterdam Destination - 300DPI'] }));
  const onReplaced = vi.fn();
  render(<ReplaceTemplateModal template={NEW} candidates={OLD} onReplaced={onReplaced} onClose={vi.fn()} />);
  await userEvent.click(screen.getByRole('checkbox', { name: 'Turn off Amsterdam Destination - 300DPI' }));
  await userEvent.click(screen.getByRole('button', { name: 'Replace' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Amsterdam Destination - 300DPI');
  expect(onReplaced).not.toHaveBeenCalled();
});
