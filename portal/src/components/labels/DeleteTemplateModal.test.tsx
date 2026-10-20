// @vitest-environment jsdom
/**
 * DeleteTemplateModal (spec §3.4, §4.9): a top-level template lists what
 * goes with it (its DPI versions and the labels generated from them) and
 * deletes only once its name is typed exactly; a DPI child goes on a plain
 * confirmation.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError, type LabelTemplate, type LabelTemplateChild } from '../../lib/api';

const api = vi.hoisted(() => ({
  getLabelTemplateDeleteSummary: vi.fn(),
  deleteLabelTemplateForGood: vi.fn(),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));

const { default: DeleteTemplateModal } = await import('./DeleteTemplateModal');

const PARENT: LabelTemplate = {
  id: 'p1', name: 'Vegas Destination', description: '', label_type: 'top', size_key: '4x2', dpi_key: '300',
  language_key: 'zpl', kind: 'design', design: { schema: 2 }, code: null, version: 7, is_active: true,
  site_ids: [], created_at: '', updated_at: '', parent_id: null, schema_version: 2, dpis: ['203', '300', '600'],
};

const kid = (dpi: string, over: Partial<LabelTemplateChild> = {}): LabelTemplateChild => ({
  ...PARENT, id: `c${dpi}`, name: `Vegas Destination · ${dpi}`, dpi_key: dpi, parent_id: 'p1',
  generated_from_version: 7, child_edits: 0, customized: false, is_old: false, out_of_date: false, ...over,
});

const CHILDREN = [
  kid('203'),
  kid('300', { customized: true, child_edits: 2 }),
  kid('300', { id: 'c300old', name: 'Vegas Destination · 300 Old', is_old: true, customized: true,
    generated_from_version: 6, child_edits: 3 }),
  kid('600'),
];

beforeEach(() => {
  vi.clearAllMocks();
  api.getLabelTemplateDeleteSummary.mockResolvedValue({
    children: CHILDREN.map((c) => c.name), generated_labels: 12, fallback_dpis_lost: [],
  });
  api.deleteLabelTemplateForGood.mockResolvedValue(undefined);
});

afterEach(cleanup);

it('lists the DPI versions and generated labels that go with a template', async () => {
  render(<DeleteTemplateModal template={PARENT} dpiChildren={CHILDREN} onDeleted={vi.fn()} onClose={vi.fn()} />);
  expect(screen.getByRole('heading', { name: 'Delete “Vegas Destination”?' })).toBeTruthy();
  await screen.findByText('Vegas Destination · 300 Old');
  expect(api.getLabelTemplateDeleteSummary).toHaveBeenCalledWith('p1');
  for (const c of CHILDREN) expect(screen.getByText(c.name)).toBeTruthy();
  expect(screen.getByText('v7.2')).toBeTruthy();       // the customized 300's version
  expect(screen.getByText('v6.3')).toBeTruthy();       // the Old one's
  expect(screen.getByText(/12 generated labels/)).toBeTruthy();
});

it('enables Delete only when the typed name matches exactly', async () => {
  const onDeleted = vi.fn();
  render(<DeleteTemplateModal template={PARENT} dpiChildren={CHILDREN} onDeleted={onDeleted} onClose={vi.fn()} />);
  await screen.findByText('Vegas Destination · 600');
  const button = screen.getByRole('button', { name: 'Delete template and 4 DPI versions' }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);

  const box = screen.getByLabelText('Type Vegas Destination to confirm');
  await userEvent.type(box, 'vegas destination');                  // case matters
  expect(button.disabled).toBe(true);
  await userEvent.clear(box);
  await userEvent.type(box, 'Vegas Destination ');                 // so does a stray space
  expect(button.disabled).toBe(true);
  await userEvent.clear(box);
  await userEvent.type(box, 'Vegas Destination');
  expect(button.disabled).toBe(false);

  await userEvent.click(button);
  await waitFor(() => expect(onDeleted).toHaveBeenCalled());
  expect(api.deleteLabelTemplateForGood).toHaveBeenCalledWith('p1', 'Vegas Destination');
});

it('a template with no DPI versions says so and still asks for its name', async () => {
  api.getLabelTemplateDeleteSummary.mockResolvedValue({ children: [], generated_labels: 0, fallback_dpis_lost: [] });
  const legacy = { ...PARENT, id: 'l1', name: 'Front tag - 203DPI', kind: 'code' as const, schema_version: 1 };
  render(<DeleteTemplateModal template={legacy} onDeleted={vi.fn()} onClose={vi.fn()} />);
  const button = await screen.findByRole('button', { name: 'Delete template' }) as HTMLButtonElement;
  expect(screen.getByText(/No labels have been generated from it/)).toBeTruthy();
  expect(button.disabled).toBe(true);
  await userEvent.type(screen.getByLabelText('Type Front tag - 203DPI to confirm'), 'Front tag - 203DPI');
  expect(button.disabled).toBe(false);
});

it('a DPI child goes on a plain confirmation, without a typed name', async () => {
  api.getLabelTemplateDeleteSummary.mockResolvedValue({ children: [], generated_labels: 3, fallback_dpis_lost: [] });
  const onDeleted = vi.fn();
  render(<DeleteTemplateModal template={CHILDREN[1]} onDeleted={onDeleted} onClose={vi.fn()} />);
  expect(screen.getByRole('heading', { name: 'Delete “Vegas Destination · 300”?' })).toBeTruthy();
  await screen.findByText(/3 generated labels/);
  expect(screen.queryByLabelText(/to confirm/)).toBeNull();
  expect(screen.getByText(/Add DPI/)).toBeTruthy();     // how to bring it back
  await userEvent.click(screen.getByRole('button', { name: 'Delete this DPI' }));
  await waitFor(() => expect(onDeleted).toHaveBeenCalled());
  expect(api.deleteLabelTemplateForGood).toHaveBeenCalledWith('c300');
});

it('shows why a delete failed and stays open', async () => {
  api.deleteLabelTemplateForGood.mockRejectedValue(new ApiError(422, 'name_mismatch'));
  const onDeleted = vi.fn();
  render(<DeleteTemplateModal template={PARENT} dpiChildren={CHILDREN} onDeleted={onDeleted} onClose={vi.fn()} />);
  await screen.findByText('Vegas Destination · 600');
  await userEvent.type(screen.getByLabelText('Type Vegas Destination to confirm'), 'Vegas Destination');
  await userEvent.click(screen.getByRole('button', { name: 'Delete template and 4 DPI versions' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/doesn.t match/);
  expect(onDeleted).not.toHaveBeenCalled();
});

it('Cancel closes without deleting', async () => {
  const onClose = vi.fn();
  render(<DeleteTemplateModal template={PARENT} dpiChildren={CHILDREN} onDeleted={vi.fn()} onClose={onClose} />);
  await screen.findByText('Vegas Destination · 600');
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onClose).toHaveBeenCalled();
  expect(api.deleteLabelTemplateForGood).not.toHaveBeenCalled();
});

it('says nothing about the fallback when the delete leaves one active', async () => {
  render(<DeleteTemplateModal template={PARENT} dpiChildren={CHILDREN} onDeleted={vi.fn()} onClose={vi.fn()} />);
  await screen.findByText('Vegas Destination · 600');
  expect(screen.queryByText(/only active Generic Rack and RU/)).toBeNull();
});

it('warns when the delete leaves no active fallback at a DPI, and still deletes', async () => {
  api.getLabelTemplateDeleteSummary.mockResolvedValue({ children: [], generated_labels: 0, fallback_dpis_lost: ['203'] });
  const legacy = { ...PARENT, id: 'g1', name: 'Generic Rack and RU - 203DPI', kind: 'code' as const, schema_version: 1 };
  const onDeleted = vi.fn();
  render(<DeleteTemplateModal template={legacy} onDeleted={onDeleted} onClose={vi.fn()} />);
  const note = await screen.findByRole('note');
  expect(note.textContent).toBe('This is the only active Generic Rack and RU template at 203 DPI. Moves without '
    + 'their own Top template will have nothing to print at that DPI until another one is active. To swap '
    + 'templates without a gap, use Replace…');
  // above the typed-name box
  const box = screen.getByLabelText('Type Generic Rack and RU - 203DPI to confirm');
  expect(note.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await userEvent.type(box, 'Generic Rack and RU - 203DPI');
  await userEvent.click(screen.getByRole('button', { name: 'Delete template' }));
  await waitFor(() => expect(onDeleted).toHaveBeenCalled());
});

it('names every DPI the delete leaves without a fallback', async () => {
  api.getLabelTemplateDeleteSummary.mockResolvedValue({
    children: CHILDREN.map((c) => c.name), generated_labels: 0, fallback_dpis_lost: ['203', '300'],
  });
  const { unmount } = render(<DeleteTemplateModal template={PARENT} dpiChildren={CHILDREN} onDeleted={vi.fn()} onClose={vi.fn()} />);
  expect((await screen.findByRole('note')).textContent).toMatch(
    /^This is the only active Generic Rack and RU template at 203 and 300 DPI\. Moves without their own Top template will have nothing to print at those DPIs until/);
  unmount();
  api.getLabelTemplateDeleteSummary.mockResolvedValue({
    children: CHILDREN.map((c) => c.name), generated_labels: 0, fallback_dpis_lost: ['203', '300', '600'],
  });
  render(<DeleteTemplateModal template={PARENT} dpiChildren={CHILDREN} onDeleted={vi.fn()} onClose={vi.fn()} />);
  expect((await screen.findByRole('note')).textContent).toMatch(/template at 203, 300 and 600 DPI\./);
});
