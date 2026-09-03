// @vitest-environment jsdom
/**
 * Topbar AI-button gating: the button (and its popover) render only for a
 * caller with ai:view — same mechanism as ProtectedRoute's can() gate.
 * A caller without the grant would otherwise hit a 403 that AiAssistant's
 * error branch shows as "Something went wrong — try again."; hiding the
 * button entirely is the honest behavior.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => {
  const state: { can: (resource: string, action?: string) => boolean } = {
    can: () => true,
  };
  return state;
});

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ can: auth.can }),
}));

vi.mock('../lib/api', () => ({
  apiFetch: vi.fn(() => new Promise(() => {})),
}));

vi.mock('./AiAssistant', () => ({
  default: () => <div>AI PANEL</div>,
}));

afterEach(() => {
  cleanup();
  auth.can = () => true;
});

function renderTopbar() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Topbar />
    </MemoryRouter>,
  );
}

const { TopbarProvider } = await import('../lib/topbar');
const { default: TopbarInner } = await import('./Topbar');

function Topbar() {
  return (
    <TopbarProvider>
      <TopbarInner />
    </TopbarProvider>
  );
}

it('hides the AI button for a caller without ai:view', () => {
  auth.can = () => false;
  renderTopbar();
  expect(screen.queryByTitle('AI assistant')).toBeNull();
});

it('shows the AI button for a caller with ai:view', () => {
  auth.can = (resource) => resource === 'ai';
  renderTopbar();
  expect(screen.getByTitle('AI assistant')).toBeDefined();
});
