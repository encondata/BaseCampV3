// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ dismissAssetModelReview: vi.fn() }));
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

const data = () => ({
  imported: [item('f1', 'R740 (Node)', { reason: 'imported', group_key: null,
    knowledge: 'FORCED: make model creation for move F-T\nmore' })],
  duplicates: [[item('a', 'PowerEdge R740', { asset_count: 3 }), item('b', 'PowerEdge_R740')]],
  dismissed_count: 2,
});

// the page owns the fetch (it needs the payload for the tab badge) and hands
// the panel `data` / `showDismissed` / `onChanged` — see AssetModels.test.tsx
type PanelProps = ComponentProps<typeof ModelReviewPanel>;
const panel = (over: Partial<PanelProps> = {}) => (
  <ModelReviewPanel canChange data={data() as never} loadError="" showDismissed={false}
                    onToggleDismissed={() => {}} onMerge={() => {}} onEdit={() => {}}
                    onChanged={() => {}} {...over} />
);

beforeEach(() => { api.dismissAssetModelReview.mockReset(); });
afterEach(cleanup);

it('renders both sections and presets the other member on Merge into…', async () => {
  const onMerge = vi.fn();
  render(panel({ onMerge }));
  expect(await screen.findByText('Created by import')).toBeTruthy();
  expect(screen.getByText('FORCED: make model creation for move F-T')).toBeTruthy();
  expect(screen.getByText('Likely duplicates')).toBeTruthy();
  expect(screen.getByText('Show dismissed (2)')).toBeTruthy();
  const row = screen.getByText('PowerEdge_R740').closest('.rv-row')!;
  fireEvent.click(row.querySelector('button[data-action="merge"]')!);
  expect(onMerge).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }), 'a');
});

it('dismiss calls the API then asks the page to reload; the toggle is lifted too', async () => {
  api.dismissAssetModelReview.mockResolvedValue({});
  const onChanged = vi.fn();
  const onToggleDismissed = vi.fn();
  render(panel({ onChanged, onToggleDismissed }));
  const row = (await screen.findByText('R740 (Node)')).closest('.rv-row')!;
  fireEvent.click(row.querySelector('button[data-action="dismiss"]')!);
  await waitFor(() => expect(api.dismissAssetModelReview).toHaveBeenCalledWith('f1', true));
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByLabelText('Show dismissed (2)'));
  expect(onToggleDismissed).toHaveBeenCalledWith(true);
});

it('shows the page\'s load error instead of an endless spinner', () => {
  render(panel({ data: null, loadError: 'Failed to load the review list.' }));
  expect(screen.getByText('Cannot load review')).toBeTruthy();
  expect(screen.getByText('Failed to load the review list.')).toBeTruthy();
});

it('the empty state says it once', () => {
  render(panel({ data: { imported: [], duplicates: [], dismissed_count: 0 } }));
  expect(screen.getByText('Nothing to review')).toBeTruthy();
  expect(screen.getByText('The catalog has no import-created or overlapping models.')).toBeTruthy();
});
