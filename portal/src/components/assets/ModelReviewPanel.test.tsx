// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ reviewAssetModels: vi.fn(), dismissAssetModelReview: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));
const { default: ModelReviewPanel } = await import('./ModelReviewPanel');

const item = (id: string, model: string, over: Record<string, unknown> = {}) => ({
  id, make: 'Dell', model, category: null, category_label: null, category_color: null,
  ru_size: null, weight_lbs: null, weight_kg: null, length_in: null, width_in: null, height_in: null,
  length_cm: null, width_cm: null, height_cm: null, mount_type: null, rail_type: null, form_factor: null,
  knowledge: '', aliases: [], review_dismissed_at: null, created_at: '', updated_at: '',
  asset_count: 1, stock_line_count: 0, reason: 'duplicate', group_key: 'dell r740', ...over,
});

beforeEach(() => {
  api.reviewAssetModels.mockReset();
  api.dismissAssetModelReview.mockReset();
  api.reviewAssetModels.mockResolvedValue({
    imported: [item('f1', 'R740 (Node)', { reason: 'imported', group_key: null,
      knowledge: 'FORCED: make model creation for move F-T\nmore' })],
    duplicates: [[item('a', 'PowerEdge R740', { asset_count: 3 }), item('b', 'PowerEdge_R740')]],
    dismissed_count: 2,
  });
});
afterEach(cleanup);

it('renders both sections and presets the other member on Merge into…', async () => {
  const onMerge = vi.fn();
  render(<ModelReviewPanel canChange onMerge={onMerge} onEdit={() => {}} reloadKey={0} />);
  expect(await screen.findByText('Created by import')).toBeTruthy();
  expect(screen.getByText('FORCED: make model creation for move F-T')).toBeTruthy();
  expect(screen.getByText('Likely duplicates')).toBeTruthy();
  expect(screen.getByText('Show dismissed (2)')).toBeTruthy();
  const row = screen.getByText('PowerEdge_R740').closest('.rv-row')!;
  fireEvent.click(row.querySelector('button[data-action="merge"]')!);
  expect(onMerge).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }), 'a');
});

it('dismiss calls the API and refetches; show dismissed refetches with the flag', async () => {
  api.dismissAssetModelReview.mockResolvedValue({});
  render(<ModelReviewPanel canChange onMerge={() => {}} onEdit={() => {}} reloadKey={0} />);
  const row = (await screen.findByText('R740 (Node)')).closest('.rv-row')!;
  fireEvent.click(row.querySelector('button[data-action="dismiss"]')!);
  await waitFor(() => expect(api.dismissAssetModelReview).toHaveBeenCalledWith('f1', true));
  await waitFor(() => expect(api.reviewAssetModels).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByLabelText('Show dismissed (2)'));
  await waitFor(() => expect(api.reviewAssetModels).toHaveBeenLastCalledWith(true));
});
