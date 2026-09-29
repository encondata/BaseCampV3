// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import type { AssetModelItem } from '../../lib/api';

const api = vi.hoisted(() => ({
  updateAssetModel: vi.fn(),
  createAssetModel: vi.fn(),
  setAssetModelAliases: vi.fn(),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));
const { default: ModelEditModal } = await import('./ModelEditModal');
afterEach(cleanup);

const model: AssetModelItem = {
  id: 'm1', make: 'Dell', model: 'R740', category: null, category_label: null, category_color: null,
  ru_size: 2, weight_lbs: null, weight_kg: null, length_in: null, width_in: null, height_in: null,
  length_cm: null, width_cm: null, height_cm: null, mount_type: null, rail_type: null,
  form_factor: null, knowledge: '', aliases: [], review_dismissed_at: null,
  private: false, spec_lookup_skip: true, specs_looked_up_at: null, created_at: '', updated_at: '',
};

it('Private / Skip spec lookup switches save only what changed', async () => {
  api.updateAssetModel.mockResolvedValue({ ...model, private: true });
  const onSaved = vi.fn();
  render(<ModelEditModal model={model} categories={[]} canChange onClose={vi.fn()} onSaved={onSaved} />);
  expect(screen.getByText('Spec lookup')).toBeTruthy();
  expect(screen.getByText('Never sent to Claude for spec lookup.')).toBeTruthy();
  const priv = screen.getByRole('checkbox', { name: 'Private' }) as HTMLInputElement;
  const skip = screen.getByRole('checkbox', { name: 'Skip spec lookup' }) as HTMLInputElement;
  expect(priv.checked).toBe(false);
  expect(skip.checked).toBe(true);
  fireEvent.click(priv);
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.updateAssetModel).toHaveBeenCalledWith('m1', { private: true }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
});

it('the switches are locked without change permission', () => {
  render(<ModelEditModal model={model} categories={[]} canChange={false} onClose={vi.fn()} onSaved={vi.fn()} />);
  expect((screen.getByRole('checkbox', { name: 'Private' }) as HTMLInputElement).disabled).toBe(true);
});
