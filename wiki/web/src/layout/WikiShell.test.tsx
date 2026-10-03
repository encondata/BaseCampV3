// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@portal/components/SystemBanners', () => ({ default: () => null }));
vi.mock('@portal/lib/notificationsContext', () => ({ useToast: () => vi.fn() }));
vi.mock('../lib/useWikiMe', () => ({ useWikiMe: () => null }));
vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  listSpaces: vi.fn(async () => []),
}));
vi.mock('./Sidebar', () => ({ default: () => <div>sidebar</div> }));
vi.mock('./TopBar', () => ({ default: () => <div>topbar</div> }));
vi.mock('../uploads/UploadTray', () => ({ default: () => null }));
vi.mock('../pages/Home', () => ({ default: () => <div>home page</div> }));
vi.mock('../pages/NodePage', () => ({ default: () => <div>node page</div> }));

import WikiShell from './WikiShell';

afterEach(cleanup);

let go: (to: string) => void = () => {};
function Nav() {
  go = useNavigate();
  return null;
}

describe('WikiShell hook order', () => {
  it('survives a client-side move from home into a document', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Nav />
        <WikiShell />
      </MemoryRouter>,
    );
    expect(await screen.findByText('home page')).toBeTruthy();
    await act(async () => { go('/n/abc'); });
    expect(await screen.findByText('node page')).toBeTruthy();
    expect(screen.queryByText(/Something went wrong/)).toBeNull();
  });
});
