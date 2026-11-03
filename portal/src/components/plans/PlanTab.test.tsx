// @vitest-environment jsdom
/**
 * components/plans/PlanTab.tsx: the initiative's Project plan tab. The
 * empty state (three ways to start, buttons only with project_plans:add),
 * creating a blank plan through PlanCreateModal, the lock banner, the view
 * switcher read from ?view=, and full screen (Escape leaves it). The real
 * usePlan runs against a mocked lib/plans/api.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api';
import { longDate } from '../../lib/format';
import type { Plan } from '../../lib/plans/api';
import { makePlan } from '../../lib/plans/planFixtures';

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../lib/notificationsContext', () => ({ useToast: () => toast }));

const auth = vi.hoisted(() => ({
  plans: { view: true, add: true, change: true, delete: true } as Record<string, boolean>,
}));
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    can: (resource: string, action = 'view') => resource === 'project_plans' && auth.plans[action] === true,
    person: { id: 'p-me', display_name: 'Jimmy Henderson' },
    preferences: {},
  }),
}));

const api = vi.hoisted(() => ({
  getPlan: vi.fn(),
  createPlan: vi.fn(),
  deletePlan: vi.fn(),
  postOps: vi.fn(),
  patchPlan: vi.fn(),
  lockPlan: vi.fn(),
  unlockPlan: vi.fn(),
  setBaseline: vi.fn(),
  clearBaseline: vi.fn(),
  updateProject: vi.fn(),
  getPlanVersion: vi.fn(),
}));
vi.mock('../../lib/plans/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/plans/api')>()),
  ...api,
}));

const { default: PlanTab } = await import('./PlanTab');

const INITIATIVE = { name: 'NAP11 Hall Migration', scheduled_start: '2026-11-14', scheduled_end: '2026-11-16' };
const EMPTY_PLAN: Plan = makePlan({ tasks: [], project_finish: null, version: 1 });
const LOCKED_AT = '2026-10-28T15:30:00Z';

const noPlan = () => new ApiError(404, 'no_plan', { code: 'no_plan' });

let location = '';
function LocationProbe() {
  const loc = useLocation();
  location = `${loc.pathname}${loc.search}`;
  return null;
}

function renderTab(search = '?tab=plan') {
  return render(
    <MemoryRouter initialEntries={[`/initiatives/init-1${search}`]}>
      <Routes>
        <Route path="/initiatives/:id" element={(
          <>
            <PlanTab initiativeId="init-1" initiative={INITIATIVE} />
            <LocationProbe />
          </>
        )} />
      </Routes>
    </MemoryRouter>,
  );
}

const root = (container: HTMLElement) => container.querySelector('.pln-tab') as HTMLElement;

/** The tab inside a stand-in of the portal's shell: nav, toasts, top bar,
 *  the page header, and one element some other surface already made inert. */
function renderInShell() {
  const alreadyInert = { inert: '' };
  return render(
    <MemoryRouter initialEntries={['/initiatives/init-1?tab=plan']}>
      <Routes>
        <Route path="/initiatives/:id" element={(
          <div className="portal-shell">
            <nav className="portal-nav"><a href="/sites">Sites</a></nav>
            <div className="portal-main-col">
              <div className="toast-host"><button type="button">Undo delete</button></div>
              <header className="topbar"><button type="button">Search everywhere</button></header>
              <main className="portal-main">
                <div className="portal-page">
                  <a href="/initiatives">← Initiatives</a>
                  <div className="other-surface" {...alreadyInert}><button type="button">Hidden already</button></div>
                  <div className="detail-grid">
                    <div className="idet-plan"><PlanTab initiativeId="init-1" initiative={INITIATIVE} /></div>
                  </div>
                </div>
              </main>
            </div>
          </div>
        )} />
      </Routes>
    </MemoryRouter>,
  );
}

const inertAround = (text: string) => screen.getByText(text).closest('[inert]') !== null;

beforeEach(() => {
  for (const fn of [toast, ...Object.values(api)]) fn.mockReset();
  auth.plans = { view: true, add: true, change: true, delete: true };
  location = '';
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('loading and errors', () => {
  it('says it is loading until the plan arrives', () => {
    api.getPlan.mockReturnValueOnce(new Promise(() => {}));
    renderTab();
    expect(screen.getByText('Loading the project plan…')).not.toBeNull();
  });

  it('shows a load failure in words with Try again, which reads the plan again', async () => {
    const user = userEvent.setup();
    api.getPlan.mockRejectedValueOnce(new ApiError(500, 'unknown_error', { code: 'unknown_error' }));
    renderTab();
    expect(await screen.findByText('Something went wrong. Try again.')).not.toBeNull();
    api.getPlan.mockResolvedValueOnce(EMPTY_PLAN);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.getPlan).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('toolbar', { name: 'Project plan' }, { timeout: 3000 })).not.toBeNull();
  });
});

describe('empty state', () => {
  it('offers three ways to start; template and import wait for a later release', async () => {
    api.getPlan.mockRejectedValueOnce(noPlan());
    renderTab();
    expect(await screen.findByText('No project plan yet')).not.toBeNull();
    const blank = screen.getByRole('button', { name: /^Blank plan/ });
    const template = screen.getByRole('button', { name: /^From a template/ });
    const imports = screen.getByRole('button', { name: /^Import from MS Project or Excel/ });
    expect(blank.hasAttribute('disabled')).toBe(false);
    expect(template.hasAttribute('disabled')).toBe(true);
    expect(imports.hasAttribute('disabled')).toBe(true);
    expect(within(template).getByText('Coming soon')).not.toBeNull();
    expect(within(imports).getByText('Coming soon')).not.toBeNull();
    expect(within(blank).queryByText('Coming soon')).toBeNull();
  });

  it('without project_plans:add shows the message only', async () => {
    auth.plans = { view: true, add: false, change: true, delete: false };
    api.getPlan.mockRejectedValueOnce(noPlan());
    renderTab();
    expect(await screen.findByText('No project plan yet')).not.toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('creating a plan', () => {
  async function openCreate() {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 2, 9, 30));     // the browser's local Mon Nov 2
    const user = userEvent.setup();
    api.getPlan.mockRejectedValueOnce(noPlan());
    const view = renderTab();
    await user.click(await screen.findByRole('button', { name: /^Blank plan/ }));
    const dialog = screen.getByRole('dialog', { name: 'New project plan' });
    return { user, dialog, ...view };
  }

  it('Blank plan opens the house modal with the project start defaulting to today', async () => {
    const { dialog } = await openCreate();
    expect(dialog.classList.contains('pln-modal')).toBe(true);
    expect(within(dialog).getByText('Project plan')).not.toBeNull();       // eyebrow
    expect(within(dialog).getByRole('heading', { level: 3, name: 'New project plan' })).not.toBeNull();
    const start = within(dialog).getByLabelText('Project start') as HTMLInputElement;
    expect(document.activeElement).toBe(start);               // focus lands on the first field
    expect(start.type).toBe('date');
    expect(start.value).toBe('2026-11-02');
    expect(start.closest('.pf-form')).not.toBeNull();
    // the initiative's own window, for context
    expect(within(dialog).getByText(/Nov 14, 2026 – Nov 16, 2026/)).not.toBeNull();
  });

  it('Create sends the chosen start date and shows the new plan', async () => {
    const { user, dialog } = await openCreate();
    fireEvent.change(within(dialog).getByLabelText('Project start'), { target: { value: '2026-11-09' } });
    api.createPlan.mockResolvedValueOnce(EMPTY_PLAN);
    await user.click(within(dialog).getByRole('button', { name: 'Create plan' }));
    expect(api.createPlan).toHaveBeenCalledWith('init-1', { project_start: '2026-11-09' });
    expect(await screen.findByRole('toolbar', { name: 'Project plan' }, { timeout: 3000 })).not.toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('No project plan yet')).toBeNull();
  });

  it('keeps the dialog open with the reason when the API refuses', async () => {
    const { user, dialog } = await openCreate();
    api.createPlan.mockRejectedValueOnce(
      new ApiError(422, 'bad_field', { code: 'bad_field', field: 'project_start' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create plan' }));
    expect(await within(dialog).findByText('Check the Project Start value.')).not.toBeNull();
    expect(screen.getByRole('dialog', { name: 'New project plan' })).not.toBeNull();
  });

  it('a blank date is not sent', async () => {
    const { user, dialog } = await openCreate();
    fireEvent.change(within(dialog).getByLabelText('Project start'), { target: { value: '' } });
    await user.click(within(dialog).getByRole('button', { name: 'Create plan' }));
    expect(within(dialog).getByText('Pick the project start date.')).not.toBeNull();
    expect(api.createPlan).not.toHaveBeenCalled();
  });

  it('when someone else just made one, closes on their plan and says so', async () => {
    const { user, dialog } = await openCreate();
    api.createPlan.mockRejectedValueOnce(new ApiError(409, 'plan_exists', { code: 'plan_exists' }));
    api.getPlan.mockResolvedValueOnce(EMPTY_PLAN);
    await user.click(within(dialog).getByRole('button', { name: 'Create plan' }));
    expect(await screen.findByRole('toolbar', { name: 'Project plan' }, { timeout: 3000 })).not.toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toast).toHaveBeenCalledWith('This initiative already has a project plan.');
  });

  it('Cancel closes without creating', async () => {
    const { user, dialog } = await openCreate();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.createPlan).not.toHaveBeenCalled();
  });
});

describe('lock banner', () => {
  it('names who locked the schedule and when, with Unlock for change holders', async () => {
    const user = userEvent.setup();
    api.getPlan.mockResolvedValueOnce(makePlan({ locked_at: LOCKED_AT, locked_by_name: 'Dana Reyes' }));
    renderTab();
    const banner = await screen.findByRole('status', { name: 'Schedule locked' }, { timeout: 3000 });
    expect(banner.textContent).toContain(
      `Schedule locked by Dana Reyes on ${longDate(LOCKED_AT)} — progress updates only`);
    api.unlockPlan.mockResolvedValueOnce(makePlan({ version: 6 }));
    await user.click(within(banner).getByRole('button', { name: 'Unlock' }));
    expect(api.unlockPlan).toHaveBeenCalledWith('plan-1');
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Schedule locked' })).toBeNull());
  });

  it('has no Unlock button without change permission', async () => {
    api.getPlan.mockResolvedValueOnce(makePlan({
      locked_at: LOCKED_AT, locked_by_name: 'Dana Reyes',
      permissions: { view: true, add: false, change: false, delete: false },
    }));
    renderTab();
    const banner = await screen.findByRole('status', { name: 'Schedule locked' }, { timeout: 3000 });
    expect(within(banner).queryByRole('button')).toBeNull();
  });

  it('a refused unlock says why and keeps the banner', async () => {
    const user = userEvent.setup();
    api.getPlan.mockResolvedValueOnce(makePlan({ locked_at: LOCKED_AT, locked_by_name: 'Dana Reyes' }));
    renderTab();
    const banner = await screen.findByRole('status', { name: 'Schedule locked' }, { timeout: 3000 });
    api.unlockPlan.mockRejectedValueOnce(new ApiError(403, 'forbidden', { code: 'forbidden' }));
    await user.click(within(banner).getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('You don’t have permission to do that.'));
    expect(screen.getByRole('status', { name: 'Schedule locked' })).not.toBeNull();
  });

  it('is absent on an unlocked plan', async () => {
    api.getPlan.mockResolvedValueOnce(makePlan());
    renderTab();
    await screen.findByRole('toolbar', { name: 'Project plan' }, { timeout: 3000 });
    expect(screen.queryByRole('status', { name: 'Schedule locked' })).toBeNull();
  });
});

describe('views', () => {
  it('shows the Gantt view by default; the switcher offers Gantt, Calendar and Board', async () => {
    api.getPlan.mockResolvedValueOnce(makePlan());
    const { container } = renderTab();
    const views = await screen.findByRole('group', { name: 'View' }, { timeout: 3000 });
    const buttons = within(views).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Gantt', 'Calendar', 'Board']);
    expect(buttons[0].getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.pln-view')?.getAttribute('data-view')).toBe('gantt');
  });

  it('an unknown ?view= falls back to the Gantt view', async () => {
    api.getPlan.mockResolvedValueOnce(makePlan());
    const { container } = renderTab('?tab=plan&view=list');
    await screen.findByRole('toolbar', { name: 'Project plan' }, { timeout: 3000 });
    expect(container.querySelector('.pln-view')?.getAttribute('data-view')).toBe('gantt');
    expect(location).toContain('tab=plan');
  });
});

describe('full screen', () => {
  it('the Full screen button toggles pln-fullscreen on the tab root, and Escape leaves it', async () => {
    const user = userEvent.setup();
    api.getPlan.mockResolvedValueOnce(makePlan());
    const { container } = renderTab();
    const button = await screen.findByRole('button', { name: 'Full screen' }, { timeout: 3000 });
    expect(root(container).classList.contains('pln-fullscreen')).toBe(false);
    expect(button.hasAttribute('aria-pressed')).toBe(false);     // the label alone says which
    expect(screen.queryByRole('heading', { name: INITIATIVE.name })).toBeNull();
    await user.click(button);
    expect(root(container).classList.contains('pln-fullscreen')).toBe(true);
    expect(screen.getByRole('button', { name: 'Exit full screen' }).hasAttribute('aria-pressed')).toBe(false);
    // the page header is covered, so the toolbar says whose plan this is
    expect(screen.getByRole('heading', { name: INITIATIVE.name })).not.toBeNull();
    await user.keyboard('{Escape}');
    expect(root(container).classList.contains('pln-fullscreen')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Full screen' }));
    await user.click(screen.getByRole('button', { name: 'Exit full screen' }));
    expect(root(container).classList.contains('pln-fullscreen')).toBe(false);
  });

  it('Escape closes an open dialog first and stays in full screen', async () => {
    const user = userEvent.setup();
    api.getPlan.mockResolvedValueOnce(makePlan());
    const { container } = renderTab();
    await user.click(await screen.findByRole('button', { name: 'Full screen' }, { timeout: 3000 }));
    // a real dialog over the tab: More › Plan settings…
    await user.click(screen.getByRole('button', { name: 'More' }));
    await user.click(screen.getByRole('menuitem', { name: 'Plan settings…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Plan settings' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(root(container).classList.contains('pln-fullscreen')).toBe(true);
    await user.keyboard('{Escape}');
    expect(root(container).classList.contains('pln-fullscreen')).toBe(false);
  });

  it('makes everything outside the tab inert while on, so Tab stays in full screen', async () => {
    const user = userEvent.setup();
    api.getPlan.mockResolvedValueOnce(makePlan());
    renderInShell();
    await user.click(await screen.findByRole('button', { name: 'Full screen' }, { timeout: 3000 }));
    for (const text of ['Sites', 'Search everywhere', '← Initiatives']) {
      expect(inertAround(text), text).toBe(true);
    }
    expect(inertAround('Undo delete')).toBe(false);            // toasts keep their actions
    expect(inertAround('Exit full screen')).toBe(false);
    expect(screen.getByRole('toolbar', { name: 'Project plan' }).closest('[inert]')).toBeNull();

    await user.keyboard('{Escape}');
    for (const text of ['Sites', 'Search everywhere', '← Initiatives']) {
      expect(inertAround(text), text).toBe(false);
    }
    expect(inertAround('Hidden already')).toBe(true);          // not ours to undo
  });

  it('lets go of the inert shell when the tab unmounts in full screen', async () => {
    const user = userEvent.setup();
    api.getPlan.mockResolvedValueOnce(makePlan());
    const { unmount } = renderInShell();
    await user.click(await screen.findByRole('button', { name: 'Full screen' }, { timeout: 3000 }));
    const nav = document.querySelector('.portal-nav') as HTMLElement;   // held across the unmount
    expect(nav.hasAttribute('inert')).toBe(true);
    unmount();
    expect(nav.hasAttribute('inert')).toBe(false);
  });

  it('Escape typed into a field stays in full screen', async () => {
    const user = userEvent.setup();
    api.getPlan.mockResolvedValueOnce(makePlan());
    const { container } = renderTab();
    await user.click(await screen.findByRole('button', { name: 'Full screen' }, { timeout: 3000 }));
    const field = document.createElement('input');      // a cell editor, the search box…
    document.body.appendChild(field);
    try {
      act(() => { field.focus(); });
      await user.keyboard('{Escape}');
      expect(root(container).classList.contains('pln-fullscreen')).toBe(true);
    } finally {
      field.remove();
    }
  });
});
