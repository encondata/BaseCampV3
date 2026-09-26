// @vitest-environment jsdom
import '../testing/pmDom';

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  getAssetUrls: vi.fn(),
  getNode: vi.fn(),
}));

import { ApiError } from '@portal/lib/api';

import { clearAssetUrls } from '../lib/assetUrls';
import { getAssetUrls, getNode } from '../lib/wikiApi';
import { makeDetail } from '../testing/fixtures';
import ReadOnlyDoc from './ReadOnlyDoc';

const SHOWN = '0f4d6a2e-3b1c-4c7e-9a55-1d2e3f405162';
const HIDDEN = '1f4d6a2e-3b1c-4c7e-9a55-1d2e3f405162';

const doc = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [
      { type: 'text', text: 'See ' },
      { type: 'pageLink', attrs: { nodeId: 'n-live', title: 'Old title' } },
      { type: 'text', text: ' and ' },
      { type: 'pageLink', attrs: { nodeId: 'n-gone', title: 'Secret page' } },
    ] },
    { type: 'wikiImage', attrs: { assetId: SHOWN, alt: 'Rack front', caption: 'Rack 12', width: null } },
    { type: 'wikiImage', attrs: { assetId: HIDDEN, alt: 'Hidden', caption: '', width: null } },
    { type: 'details', content: [
      { type: 'detailsSummary', content: [{ type: 'text', text: 'More' }] },
      { type: 'detailsContent', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Tucked away' }] }] },
    ] },
  ],
};

beforeEach(() => {
  clearAssetUrls();
  vi.mocked(getAssetUrls).mockResolvedValue({ [SHOWN]: 'https://s3/rack.png' });
  vi.mocked(getNode).mockImplementation(async (id) => {
    if (id === 'n-live') return makeDetail('n-live', { title: 'Cabling standards' });
    throw new ApiError(404, 'not_found');
  });
});
afterEach(cleanup);

describe('ReadOnlyDoc', () => {
  it('renders images by asset URL and a placeholder for one that is not viewable', async () => {
    render(<MemoryRouter><ReadOnlyDoc content={doc} /></MemoryRouter>);
    const img = await screen.findByRole('img', { name: 'Rack front' });
    expect(img.getAttribute('src')).toBe('https://s3/rack.png');
    expect(screen.getByText('Rack 12')).toBeTruthy();
    expect(await screen.findByText('Image unavailable')).toBeTruthy();
    expect(getAssetUrls).toHaveBeenCalledTimes(1);
  });

  it('shows page links by their current title, or "Missing page"', async () => {
    render(<MemoryRouter><ReadOnlyDoc content={doc} /></MemoryRouter>);
    expect(await screen.findByRole('link', { name: 'Cabling standards' })).toBeTruthy();
    expect(await screen.findByText('Missing page')).toBeTruthy();
    expect(screen.queryByText('Secret page')).toBeNull();
  });

  it('keeps a collapsible section closed until toggled', async () => {
    render(<MemoryRouter><ReadOnlyDoc content={doc} /></MemoryRouter>);
    const toggle = await screen.findByRole('button', { name: 'Expand section' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[contenteditable="true"]')).toBeNull();
  });
});
