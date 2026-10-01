// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./wikiApi')>()),
  getNode: vi.fn(),
}));

import { makeDetail } from '../testing/fixtures';
import { clearNodeTitles, nodeInfo } from './nodeTitles';
import { getNode } from './wikiApi';

afterEach(() => { clearNodeTitles(); vi.mocked(getNode).mockReset(); });

describe('nodeInfo', () => {
  it('says a node can be printed only when the API says so', async () => {
    vi.mocked(getNode).mockResolvedValue(makeDetail('a', { title: 'A', can_print: true }));
    expect(await nodeInfo('a')).toEqual({ title: 'A', canPrint: true });
    vi.mocked(getNode).mockResolvedValue(makeDetail('b', { title: 'B', can_print: false }));
    expect(await nodeInfo('b')).toEqual({ title: 'B', canPrint: false });
  });

  it('fails closed when the answer leaves it out', async () => {
    const { can_print: _omitted, ...bare } = makeDetail('c', { title: 'C' });
    vi.mocked(getNode).mockResolvedValue(bare as never);
    expect(await nodeInfo('c')).toEqual({ title: 'C', canPrint: false });
  });
});
