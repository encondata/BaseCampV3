// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ctx = vi.hoisted(() => ({
  newItems: [] as { id: string; kind: string; title: string; body: string; link: string | null; payload: Record<string, unknown> }[],
  dismissNew: vi.fn(),
  markRead: vi.fn(() => Promise.resolve()),
}));
vi.mock('@portal/lib/notificationsContext', () => ({
  useNotifications: () => ctx,
  useLocalToasts: () => ({ toasts: [], dismiss: vi.fn() }),
}));

vi.mock('../lib/inboxLinks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/inboxLinks')>()),
  leaveFor: vi.fn(),
}));

import { leaveFor } from '../lib/inboxLinks';
import WikiToastHost from './WikiToastHost';

function Probe() {
  const loc = useLocation();
  return <div>at {loc.pathname}{loc.search}</div>;
}

function renderHost() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <WikiToastHost />
      <Routes><Route path="*" element={<Probe />} /></Routes>
    </MemoryRouter>,
  );
}

afterEach(() => { cleanup(); vi.clearAllMocks(); ctx.newItems = []; });

describe('WikiToastHost', () => {
  it('opens a portal path in the portal', () => {
    ctx.newItems = [{ id: 'n1', kind: 'report_failed', title: 'Move Report failed', body: '', link: '/reports', payload: {} }];
    renderHost();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(leaveFor).toHaveBeenCalledWith('http://localhost:5173/reports');
    expect(ctx.markRead).toHaveBeenCalledWith('n1');
    expect(screen.getByText('at /')).toBeTruthy();
  });

  it('opens a wiki link in-app', () => {
    ctx.newItems = [{ id: 'n2', kind: 'wiki_mention', title: 'You were mentioned', body: '',
      link: `${location.origin}/n/abc`, payload: {} }];
    renderHost();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByText('at /n/abc')).toBeTruthy();
    expect(leaveFor).not.toHaveBeenCalled();
  });
});
