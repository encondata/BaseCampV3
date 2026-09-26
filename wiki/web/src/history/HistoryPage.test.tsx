// @vitest-environment jsdom
import '../testing/pmDom';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
vi.mock('@portal/lib/notificationsContext', () => ({ useToast: () => toast }));
vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  getNode: vi.fn(),
  listVersions: vi.fn(),
  getVersion: vi.fn(),
  getAssetUrls: vi.fn(),
}));

import type { JSONContent } from '@tiptap/core';

import type { Level, VersionDetail, VersionOut } from '../lib/types';
import { getNode, getVersion, listVersions } from '../lib/wikiApi';
import { makeDetail } from '../testing/fixtures';
import HistoryPage from './HistoryPage';

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const at = (iso: string) => new Date(iso).toISOString();
const ADA = { id: 'p-2', name: 'Ada Lovelace' };
const V: VersionOut[] = [
  { id: 'v5', version_no: 5, kind: 'autosave', title: 'Rack power', note: null, created_by: ADA, created_at: at('2026-09-24T16:00:00') },
  { id: 'v4', version_no: 4, kind: 'autosave', title: 'Rack power', note: null, created_by: ADA, created_at: at('2026-09-24T15:00:00') },
  { id: 'v3', version_no: 3, kind: 'published', title: 'Rack power', note: 'First cut', created_by: ADA, created_at: at('2026-09-23T10:00:00') },
  { id: 'v2', version_no: 2, kind: 'autosave', title: 'Rack power', note: null, created_by: ADA, created_at: at('2026-09-22T10:00:00') },
];
const PUBLISHED_ONLY = V.filter((v) => v.kind === 'published');

const para = (t: string): JSONContent => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
const CONTENT: Record<string, JSONContent> = {
  v5: { type: 'doc', content: [para('Turn off the PDU power first.')] },
  v4: { type: 'doc', content: [para('Turn off the PDU power first.')] },
  v3: { type: 'doc', content: [para('Turn off the rack power first.')] },
  v2: { type: 'doc', content: [para('Draft')] },
};

function Probe() {
  const loc = useLocation();
  return <div data-testid="probe">{loc.pathname}{loc.search}</div>;
}

function renderHistory(level: Level) {
  vi.mocked(getNode).mockResolvedValue(makeDetail('p1', { title: 'Rack power', my_level: level }));
  vi.mocked(listVersions).mockResolvedValue(level === 'view' ? PUBLISHED_ONLY : V);
  return render(
    <MemoryRouter initialEntries={['/n/p1/history']}>
      <Routes>
        <Route path="/n/:nodeId/history" element={<HistoryPage />} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  toast.mockReset();
  vi.mocked(getVersion).mockReset().mockImplementation(async (_id, vid) => ({
    ...V.find((v) => v.id === vid)!, content_json: CONTENT[vid],
  }) as VersionDetail);
});
afterEach(cleanup);

describe('HistoryPage', () => {
  it('lists versions: published ones marked, autosaves grouped by day and collapsed', async () => {
    renderHistory('edit');
    const list = await screen.findByRole('list', { name: 'Versions' });
    const published = within(list).getByRole('button', { name: /Version 3/ });
    expect(within(published).getByText('Published')).toBeTruthy();
    expect(within(published).getByText('First cut')).toBeTruthy();
    // the two autosaves on the 24th fold into one group
    const group = within(list).getByRole('button', { name: /2 autosaves/ });
    expect(group.getAttribute('aria-expanded')).toBe('false');
    expect(within(list).queryByRole('button', { name: /Version 5/ })).toBeNull();
    fireEvent.click(group);
    expect(within(list).getByRole('button', { name: /Version 5/ })).toBeTruthy();
    expect(within(list).getByRole('button', { name: /Version 4/ })).toBeTruthy();
  });

  it('previews the selected version read-only', async () => {
    renderHistory('edit');
    fireEvent.click(await screen.findByRole('button', { name: /Version 3/ }));
    expect(await screen.findByText('Turn off the rack power first.')).toBeTruthy();
    expect(getVersion).toHaveBeenCalledWith('p1', 'v3');
    expect(document.querySelector('[contenteditable="true"]')).toBeNull();
  });

  it('compares two versions with a word diff', async () => {
    renderHistory('edit');
    fireEvent.click(await screen.findByRole('button', { name: /Version 3/ }));
    await screen.findByText('Turn off the rack power first.');
    fireEvent.focus(screen.getByRole('combobox', { name: 'Compare with' }));
    fireEvent.mouseDown(screen.getByRole('button', { name: /^Version 5/ }));
    const diff = await screen.findByTestId('diff-view');
    await waitFor(() => expect(diff.querySelector('del')?.textContent).toContain('rack'));
    expect(diff.querySelector('ins')?.textContent).toContain('PDU');
  });

  it('hides Restore from viewers, who only see published versions', async () => {
    renderHistory('view');
    await screen.findByRole('button', { name: /Version 3/ });
    expect(screen.queryByRole('button', { name: /autosave/ })).toBeNull();
    await screen.findByText('Turn off the rack power first.');
    expect(screen.queryByRole('button', { name: 'Restore this version' })).toBeNull();
  });

  it('restores through the editor: confirm, then open it with the restore param', async () => {
    renderHistory('edit');
    fireEvent.click(await screen.findByRole('button', { name: /Version 3/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore this version' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Restore' }));
    expect(screen.getByTestId('probe').textContent).toBe('/n/p1?edit=1&restore=v3');
  });
});
