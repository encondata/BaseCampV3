// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ mergeAssetModel: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));
const { default: ModelMergeModal } = await import('./ModelMergeModal');

const model = (over: Record<string, unknown>) => ({
  id: 'm1', make: 'Dell', model: 'PowerEdge R740', category: null, category_label: null,
  category_color: null, ru_size: null, weight_lbs: null, weight_kg: null,
  length_in: null, width_in: null, height_in: null, length_cm: null, width_cm: null, height_cm: null,
  mount_type: null, rail_type: null, form_factor: null, knowledge: '', aliases: [],
  review_dismissed_at: null, created_at: '2026-01-01', updated_at: '2026-01-01', ...over,
}) as never;
const target = model({ id: 't1' });
const source = model({ id: 's1', model: 'PowerEdge_R740', ru_size: 2 });
const plan = {
  target: { ...(target as Record<string, unknown>), asset_count: 2, stock_line_count: 0 },
  source: { ...(source as Record<string, unknown>), asset_count: 3, stock_line_count: 1 },
  moves: { assets: 3, stock_lines: 1, aliases: 0 }, fills: { ru_size: 2 },
  alias_added: 'Dell PowerEdge_R740', aliases_after: ['Dell PowerEdge_R740'],
  conflicts: [], can_merge: true, applied: false,
};

beforeEach(() => { api.mergeAssetModel.mockReset(); });
afterEach(cleanup);

it('dry-runs on target pick, renders the plan, then merges', async () => {
  api.mergeAssetModel.mockResolvedValueOnce(plan).mockResolvedValueOnce({ ...plan, applied: true });
  const onMerged = vi.fn();
  render(<ModelMergeModal source={source} models={[target, source]} presetTargetId="t1"
                          onClose={() => {}} onMerged={onMerged} />);
  await waitFor(() => expect(api.mergeAssetModel).toHaveBeenCalledWith('t1', 's1', true));
  expect(await screen.findByText('3 assets and 1 stock line move; 0 aliases move; alias added: Dell PowerEdge_R740')).toBeTruthy();
  expect(screen.getByText('RU size').closest('tr')!.textContent).toContain('2');
  fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
  await waitFor(() => expect(api.mergeAssetModel).toHaveBeenLastCalledWith('t1', 's1', false));
  await waitFor(() => expect(onMerged).toHaveBeenCalled());
});

it('conflicts disable Merge and are listed', async () => {
  api.mergeAssetModel.mockResolvedValueOnce({ ...plan, can_merge: false,
    conflicts: [{ alias: 'Dell R-640', model_id: 'x', make: 'Dell', model: 'R650' }] });
  render(<ModelMergeModal source={source} models={[target, source]} presetTargetId="t1"
                          onClose={() => {}} onMerged={() => {}} />);
  expect(await screen.findByText("‘Dell R-640’ already belongs to Dell R650 — remove it there first.")).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Merge' }) as HTMLButtonElement).disabled).toBe(true);
});
