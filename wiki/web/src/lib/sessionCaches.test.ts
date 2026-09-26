import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./wikiApi', () => ({ getAssetUrls: vi.fn(), getNode: vi.fn(), getMe: vi.fn() }));
vi.mock('./useWikiMe', () => ({ clearWikiMe: vi.fn() }));

import { resolveAssetUrl } from './assetUrls';
import { nodeTitle } from './nodeTitles';
import { clearSessionCaches } from './sessionCaches';
import { clearWikiMe } from './useWikiMe';
import { getAssetUrls, getNode } from './wikiApi';

const ASSET = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  vi.mocked(getAssetUrls).mockReset().mockImplementation(async (ids) =>
    Object.fromEntries(ids.map((id) => [id, `https://s3/${id}`])));
  vi.mocked(getNode).mockReset().mockResolvedValue({ title: 'Cabling standards' } as never);
});

describe('clearSessionCaches (sign-out)', () => {
  it('forgets asset URLs, page-link titles and the wiki profile', async () => {
    await resolveAssetUrl(ASSET);
    await nodeTitle('n1');
    await resolveAssetUrl(ASSET);
    await nodeTitle('n1');
    expect(getAssetUrls).toHaveBeenCalledTimes(1);
    expect(getNode).toHaveBeenCalledTimes(1);

    clearSessionCaches();
    expect(clearWikiMe).toHaveBeenCalled();
    await resolveAssetUrl(ASSET);
    await nodeTitle('n1');
    expect(getAssetUrls).toHaveBeenCalledTimes(2);
    expect(getNode).toHaveBeenCalledTimes(2);
  });
});
