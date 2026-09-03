// @vitest-environment jsdom
/**
 * FixMakeModelDialog — the review-row fix surface opened from the import
 * report (per-row "Fix…" / the missing-make-models card). Covers both
 * modes: "Create model" (hands off to ModelEditModal, then appends the
 * original CSV string as an alias on the just-created record — only when
 * that string doesn't already read like the saved "make model") and "Map
 * to existing" (ComboBox pick + read-modify-write alias append). Mocking
 * style mirrors NotificationGroupDetail.test.tsx (hoisted lib/api mock).
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import FixMakeModelDialog from './FixMakeModelDialog';

const api = vi.hoisted(() => ({
  listAssetModels: vi.fn(),
  listAssetCategories: vi.fn(),
  createAssetModel: vi.fn(),
  updateAssetModel: vi.fn(),
  setAssetModelAliases: vi.fn(),
}));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('map-to-existing appends the csv string as an alias', async () => {
  api.listAssetCategories.mockResolvedValue([]);
  api.listAssetModels.mockResolvedValue([
    { id: 'm1', make: 'Dell', model: 'PowerEdge R720', aliases: ['old'] },
  ] as never);
  api.setAssetModelAliases.mockResolvedValue({});
  const onFixed = vi.fn();
  render(<FixMakeModelDialog text="Dell Dell PowerEdge R720" make="Dell"
    model="PowerEdge R720" onClose={() => {}} onFixed={onFixed} />);

  await userEvent.click(await screen.findByText('Map to existing'));

  // select the model through the ComboBox (its input carries an explicit
  // role="combobox", not the implicit "textbox" role of a bare <input>)
  const combo = await screen.findByRole('combobox');
  await userEvent.click(combo);
  await userEvent.type(combo, 'PowerEdge');
  await userEvent.click(await screen.findByText('Dell PowerEdge R720'));
  await userEvent.click(screen.getByRole('button', { name: /Add alias|Map/ }));

  await waitFor(() => expect(api.setAssetModelAliases).toHaveBeenCalledWith(
    'm1', ['old', 'Dell Dell PowerEdge R720']));
  expect(onFixed).toHaveBeenCalledWith('Dell Dell PowerEdge R720');
});

it('map-to-existing does not duplicate an alias that already matches case-insensitively', async () => {
  api.listAssetCategories.mockResolvedValue([]);
  api.listAssetModels.mockResolvedValue([
    { id: 'm1', make: 'Dell', model: 'PowerEdge R720', aliases: ['dell dell poweredge r720'] },
  ] as never);
  api.setAssetModelAliases.mockResolvedValue({});
  const onFixed = vi.fn();
  render(<FixMakeModelDialog text="Dell Dell PowerEdge R720" make="Dell"
    model="PowerEdge R720" onClose={() => {}} onFixed={onFixed} />);

  await userEvent.click(await screen.findByText('Map to existing'));
  const combo = await screen.findByRole('combobox');
  await userEvent.click(combo);
  await userEvent.type(combo, 'PowerEdge');
  await userEvent.click(await screen.findByText('Dell PowerEdge R720'));
  await userEvent.click(screen.getByRole('button', { name: /Add alias|Map/ }));

  await waitFor(() => expect(onFixed).toHaveBeenCalledWith('Dell Dell PowerEdge R720'));
  expect(api.setAssetModelAliases).toHaveBeenCalledWith(
    'm1', ['dell dell poweredge r720']);
});

it('create-model flow appends the csv alias when it differs from the saved make+model', async () => {
  api.listAssetCategories.mockResolvedValue([]);
  api.createAssetModel.mockResolvedValue({
    id: 'm9', make: 'Dell', model: 'PowerEdge R720', aliases: [],
  } as never);
  api.setAssetModelAliases.mockResolvedValue({});
  const onFixed = vi.fn();
  render(<FixMakeModelDialog text="Dell Dell PowerEdge R720" make="Dell"
    model="PowerEdge R720" onClose={() => {}} onFixed={onFixed} />);

  await userEvent.click(await screen.findByText('Create model'));
  // ModelEditModal's create-mode submit button also reads "Create model" —
  // by now the choice screen is unmounted so this is unambiguous.
  await userEvent.click(await screen.findByRole('button', { name: 'Create model' }));

  await waitFor(() => expect(api.createAssetModel).toHaveBeenCalled());
  await waitFor(() => expect(api.setAssetModelAliases).toHaveBeenCalledWith(
    'm9', ['Dell Dell PowerEdge R720']));
  expect(onFixed).toHaveBeenCalledWith('Dell Dell PowerEdge R720');
});

it('create-model flow skips the alias append when the csv string already matches make+model', async () => {
  api.listAssetCategories.mockResolvedValue([]);
  api.createAssetModel.mockResolvedValue({
    id: 'm9', make: 'Dell', model: 'PowerEdge R720', aliases: [],
  } as never);
  const onFixed = vi.fn();
  render(<FixMakeModelDialog text="dell poweredge r720" make="Dell"
    model="PowerEdge R720" onClose={() => {}} onFixed={onFixed} />);

  await userEvent.click(await screen.findByText('Create model'));
  await userEvent.click(await screen.findByRole('button', { name: 'Create model' }));

  await waitFor(() => expect(api.createAssetModel).toHaveBeenCalled());
  await waitFor(() => expect(onFixed).toHaveBeenCalledWith('dell poweredge r720'));
  expect(api.setAssetModelAliases).not.toHaveBeenCalled();
});
