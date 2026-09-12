// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CachedBundle } from '../../lib/labelCache';
import OfflineCacheModal from './OfflineCacheModal';

afterEach(cleanup);

const bundle = (initiative_id: string, initiative_name: string, label_type: string, n: number): CachedBundle => ({
  initiative_id, initiative_name, label_type, fetched_at: '2026-09-12T00:00:00Z',
  cached_at: new Date(Date.now() - 120_000).toISOString(),
  labels: Array.from({ length: n }, (_, i) => ({
    id: `${label_type}${i}`, entity_type: 'asset', entity_id: `a${i}`, template_id: 't', template_name: 'T',
    template_version: 1, language_key: 'zpl', size_key: '4x2', dpi_key: '203', stale: false,
    generated_at: '2026-09-12T00:00:00Z', code: '^XA^XZ',
  })),
});

const TYPES = [{ key: 'top', label: 'Top Label' }, { key: 'front', label: 'Front Label' }];

function setup(over: Partial<Parameters<typeof OfflineCacheModal>[0]> = {}) {
  const h = {
    onDownload: vi.fn(async () => undefined), onRemove: vi.fn(async () => undefined),
    onClearAll: vi.fn(async () => undefined), onClose: vi.fn(),
  };
  render(<OfflineCacheModal bundles={[bundle('i1', 'NAP11', 'top', 185), bundle('i2', 'NAP22', 'front', 3)]}
                            selectedInitiative={{ id: 'i1', name: 'NAP11' }} labelTypes={TYPES}
                            downloading={false} downloadStatus={null} {...h} {...over} />);
  return h;
}

describe('OfflineCacheModal', () => {
  it('lists cached bundles with counts and ages, and removes one', async () => {
    const h = setup();
    expect(screen.getByText('Offline labels')).toBeTruthy();
    expect(screen.getByText('NAP11')).toBeTruthy();
    expect(screen.getByText('185')).toBeTruthy();
    expect(screen.getAllByText('2m ago').length).toBe(2);
    await userEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1]);
    expect(h.onRemove).toHaveBeenCalledWith('i2', 'front');
  });

  it('downloads the checked label types for the selected initiative', async () => {
    const h = setup();
    expect(screen.getByText('Download for NAP11')).toBeTruthy();
    await userEvent.click(screen.getByLabelText('Front Label'));   // Top is checked by default (all types)
    await userEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(h.onDownload).toHaveBeenCalledWith(['top']);
  });

  it('shows the download status and disables Download while downloading', () => {
    setup({ downloading: true, downloadStatus: 'Cached 2 types · 370 labels' });
    expect(screen.getByText('Cached 2 types · 370 labels')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Downloading…' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('asks before clearing everything', async () => {
    const h = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(h.onClearAll).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Yes, clear the cache' }));
    expect(h.onClearAll).toHaveBeenCalledTimes(1);
  });

  it('shows the empty state and hides the download row without a selected initiative', () => {
    setup({ bundles: [], selectedInitiative: null });
    expect(screen.getByText('Nothing cached yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
    expect(screen.getByText('Pick an initiative on the page to download its labels.')).toBeTruthy();
  });

  it('checks label types that arrive after mount', async () => {
    const h = {
      onDownload: vi.fn(async () => undefined), onRemove: vi.fn(async () => undefined),
      onClearAll: vi.fn(async () => undefined), onClose: vi.fn(),
    };
    const { rerender } = render(<OfflineCacheModal bundles={[bundle('i1', 'NAP11', 'top', 185)]}
                                selectedInitiative={{ id: 'i1', name: 'NAP11' }} labelTypes={[]}
                                downloading={false} downloadStatus={null} {...h} />);
    expect(screen.queryByLabelText('Top Label')).toBeNull();
    rerender(<OfflineCacheModal bundles={[bundle('i1', 'NAP11', 'top', 185)]}
             selectedInitiative={{ id: 'i1', name: 'NAP11' }} labelTypes={TYPES}
             downloading={false} downloadStatus={null} {...h} />);
    expect((screen.getByLabelText('Top Label') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Front Label') as HTMLInputElement).checked).toBe(true);
    await userEvent.click(screen.getByLabelText('Front Label'));
    rerender(<OfflineCacheModal bundles={[bundle('i1', 'NAP11', 'top', 185)]}
             selectedInitiative={{ id: 'i1', name: 'NAP11' }} labelTypes={[...TYPES]}
             downloading={false} downloadStatus={null} {...h} />);
    expect((screen.getByLabelText('Top Label') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Front Label') as HTMLInputElement).checked).toBe(false);
  });

  it('uses the latest onRemove', async () => {
    const oldRemove = vi.fn(async () => undefined);
    const newRemove = vi.fn(async () => undefined);
    const h = {
      onDownload: vi.fn(async () => undefined), onRemove: oldRemove,
      onClearAll: vi.fn(async () => undefined), onClose: vi.fn(),
    };
    const { rerender } = render(<OfflineCacheModal bundles={[bundle('i1', 'NAP11', 'top', 185)]}
                                selectedInitiative={{ id: 'i1', name: 'NAP11' }} labelTypes={TYPES}
                                downloading={false} downloadStatus={null} {...h} />);
    rerender(<OfflineCacheModal bundles={[bundle('i1', 'NAP11', 'top', 185)]}
             selectedInitiative={{ id: 'i1', name: 'NAP11' }} labelTypes={TYPES}
             downloading={false} downloadStatus={null} onDownload={h.onDownload} onRemove={newRemove}
             onClearAll={h.onClearAll} onClose={h.onClose} />);
    await userEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]);
    expect(newRemove).toHaveBeenCalledWith('i1', 'top');
    expect(oldRemove).not.toHaveBeenCalled();
  });
});
