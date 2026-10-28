// @vitest-environment jsdom
/**
 * components/plans/PlanToolbar.tsx: MS Project's ribbon groups in order,
 * tooltips with the shortcut, who sees what (read-only: Display and More
 * only), the locked plan's hint, the More menu, and the toolbar's one tab
 * stop with arrow keys between its buttons.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Plan } from '../../lib/plans/api';
import { makePlan, makeTask } from '../../lib/plans/planFixtures';
import PlanToolbar, { LOCKED_HINT, NO_BASELINE_HINT, useRovingToolbar } from './PlanToolbar';
import type { PlanCommands } from './usePlanCommands';

afterEach(cleanup);

function commands(over: Partial<PlanCommands> = {}): PlanCommands {
  const fn = () => vi.fn();
  return {
    selected: [makeTask('a')], mode: 'auto', onTimeline: false,
    display: { critical: false, baseline: false }, zoom: 'days', chartScroll: null,
    goToTask: fn(), setBaseline: fn(),
    undo: fn(), redo: fn(), percent: fn(), markOnTrack: fn(), link: fn(), unlink: fn(), indent: fn(),
    outdent: fn(), setMode: fn(), insert: fn(), timeline: fn(), deleteTasks: fn(), confirmDelete: vi.fn(async () => {}),
    info: fn(), toggleCritical: fn(), toggleBaseline: fn(), zoomIn: fn(), zoomOut: fn(), fit: fn(), scrollToTask: fn(),
    collapse: fn(), expand: fn(), copy: vi.fn(() => true), cut: fn(), paste: fn(), lock: fn(), unlock: fn(), open: fn(),
    focusSheet: fn(), handlers: {},
    ...over,
  };
}

const CTL = { canUndo: true, canRedo: false, undoLabel: 'Indent', redoLabel: null };

function Bar({ plan, cmd }: { plan: Plan; cmd: PlanCommands }) {
  const ref = useRef<HTMLDivElement>(null);
  useRovingToolbar(ref);
  return (
    <div role="toolbar" aria-label="Project plan" ref={ref}>
      <PlanToolbar plan={plan} ctl={CTL} commands={cmd} platform="win" />
    </div>
  );
}

const groups = () => within(screen.getByRole('toolbar')).getAllByRole('group').map((g) => g.getAttribute('aria-label'));
const button = (name: string) => screen.getByRole('button', { name });

describe('groups', () => {
  it('shows MS Project’s groups in order, with the shortcut in each tooltip', () => {
    render(<Bar plan={makePlan()} cmd={commands()} />);
    expect(groups()).toEqual(['Undo', 'Schedule', 'Tasks', 'Insert', 'Properties', 'Display']);
    expect(within(screen.getByRole('group', { name: 'Schedule' })).getAllByRole('button').map((b) => b.getAttribute('aria-label')))
      .toEqual(['0% Complete', '25% Complete', '50% Complete', '75% Complete', '100% Complete', 'Mark on Track',
        'Link Tasks', 'Unlink Tasks', 'Outdent', 'Indent']);
    expect(button('Indent').title).toBe('Indent (Alt+Shift+→)');
    expect(button('Link Tasks').title).toBe('Link Tasks (Ctrl+F2) — Select two or more tasks');
    expect(button('Undo').title).toBe('Undo Indent (Ctrl+Z)');
    expect(button('Redo').title).toBe('Redo (Ctrl+Y or Ctrl+Shift+Z) — Nothing to redo');
    expect(screen.getByRole('button', { name: 'More ▾' })).toBeTruthy();
  });

  it('read-only: only Display (and More, with what a reader can use)', async () => {
    const user = userEvent.setup();
    render(<Bar plan={makePlan({ permissions: { view: true, add: false, change: false, delete: false } })}
                cmd={commands()} />);
    expect(groups()).toEqual(['Display']);
    expect(screen.queryByRole('group', { name: 'Schedule' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Insert' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'More ▾' }));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Columns…', 'Keyboard shortcuts']);
  });

  it('locked: Indent and the other schedule changes are off, saying why; progress still works', () => {
    const cmd = commands();
    render(<Bar plan={makePlan({ locked_at: '2026-10-27T12:00:00Z' })} cmd={cmd} />);
    const indent = button('Indent');
    expect(indent.getAttribute('aria-disabled')).toBe('true');
    expect(indent.title).toBe(`Indent (Alt+Shift+→) — ${LOCKED_HINT}`);
    fireEvent.click(indent);
    expect(cmd.indent).not.toHaveBeenCalled();
    for (const name of ['Link Tasks', 'Unlink Tasks', 'Outdent', 'Insert Task', 'Insert Milestone', 'Add to Timeline']) {
      expect(button(name).title, name).toContain(LOCKED_HINT);
    }
    expect(screen.getByRole('button', { name: 'Manual' }).getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button('50% Complete'));
    expect(cmd.percent).toHaveBeenCalledWith(50);
    fireEvent.click(button('Mark on Track'));
    expect(cmd.markOnTrack).toHaveBeenCalled();
  });

  it('nothing selected: the commands that need a task say so', () => {
    render(<Bar plan={makePlan()} cmd={commands({ selected: [], mode: null })} />);
    expect(button('Indent').title).toBe('Indent (Alt+Shift+→) — Select a task first');
    expect(button('25% Complete').getAttribute('aria-disabled')).toBe('true');
    expect(button('Insert Task').getAttribute('aria-disabled')).toBeNull();     // above the blank row: at the end
  });

  it('Auto / Manual shows the selection’s mode and sets it', () => {
    const cmd = commands({ mode: 'manual' });
    render(<Bar plan={makePlan()} cmd={cmd} />);
    expect(screen.getByRole('button', { name: 'Manual' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Auto' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
    expect(cmd.setMode).toHaveBeenCalledWith('auto');
  });

  it('Information and Notes open Task Information (Notes on its tab), even on a locked plan', () => {
    const cmd = commands();
    render(<Bar plan={makePlan({ locked_at: '2026-10-27T12:00:00Z' })} cmd={cmd} />);
    expect(button('Information').title).toBe('Information (Shift+F2)');
    fireEvent.click(button('Information'));
    expect(cmd.info).toHaveBeenLastCalledWith();
    fireEvent.click(button('Notes'));
    expect(cmd.info).toHaveBeenLastCalledWith('notes');
  });

  it('Information and Notes need a task selected', () => {
    render(<Bar plan={makePlan()} cmd={commands({ selected: [], mode: null })} />);
    expect(button('Information').title).toBe('Information (Shift+F2) — Select a task first');
    expect(button('Notes').getAttribute('aria-disabled')).toBe('true');
  });

  it('Display toggles show their state; zoom stops at the ends', () => {
    const cmd = commands({ display: { critical: true, baseline: false }, zoom: 'hours' });
    render(<Bar plan={makePlan()} cmd={cmd} />);
    expect(button('Critical Path').getAttribute('aria-pressed')).toBe('true');
    expect(button('Baseline').getAttribute('aria-pressed')).toBe('false');
    expect(button('Zoom In').getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button('Zoom Out'));
    expect(cmd.zoomOut).toHaveBeenCalled();
  });
});

describe('More', () => {
  it('lists the plan commands, each opening its dialog; the menu sits above full screen', async () => {
    const user = userEvent.setup();
    const cmd = commands();
    render(<Bar plan={makePlan({ baseline_set_at: '2026-10-20T10:00:00Z' })} cmd={cmd} />);
    await user.click(screen.getByRole('button', { name: 'More ▾' }));
    expect(screen.getAllByRole('menuitem').map((m) => m.firstChild?.textContent)).toEqual([
      'Set baseline…', 'Clear baseline…', 'Update project…', 'Lock schedule…', 'Plan settings…', 'Columns…',
      'Keyboard shortcuts', 'Delete plan…',
    ]);
    const menu = document.querySelector('.pop-menu') as HTMLElement;
    expect(Number(menu.style.zIndex)).toBeGreaterThan(60);
    await user.click(screen.getByRole('menuitem', { name: 'Set baseline…' }));
    expect(cmd.setBaseline).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'More ▾' }));
    await user.click(screen.getByRole('menuitem', { name: 'Lock schedule…' }));
    expect(cmd.lock).toHaveBeenCalled();
    for (const [item, kind] of [['Clear baseline…', 'clearBaseline'], ['Update project…', 'updateProject'],
      ['Plan settings…', 'settings'], ['Delete plan…', 'deletePlan'], ['Columns…', 'columns']] as const) {
      await user.click(screen.getByRole('button', { name: 'More ▾' }));
      await user.click(screen.getByRole('menuitem', { name: item }));
      expect(cmd.open).toHaveBeenLastCalledWith(kind);
    }
  });

  it('no baseline yet: Clear baseline is off, saying why', async () => {
    const user = userEvent.setup();
    render(<Bar plan={makePlan({ baseline_set_at: null })} cmd={commands()} />);
    await user.click(screen.getByRole('button', { name: 'More ▾' }));
    const clear = screen.getByRole('menuitem', { name: 'Clear baseline…' }) as HTMLButtonElement;
    expect(clear.disabled).toBe(true);
    expect(clear.textContent).toContain(NO_BASELINE_HINT);
  });

  it('a locked plan offers Unlock schedule; the baseline waits for it, Update project doesn’t', async () => {
    const user = userEvent.setup();
    const cmd = commands();
    render(<Bar plan={makePlan({ locked_at: '2026-10-27T12:00:00Z' })} cmd={cmd} />);
    await user.click(screen.getByRole('button', { name: 'More ▾' }));
    const set = screen.getByRole('menuitem', { name: 'Set baseline…' }) as HTMLButtonElement;
    expect(set.disabled).toBe(true);
    expect(set.textContent).toContain(LOCKED_HINT);
    expect((screen.getByRole('menuitem', { name: 'Update project…' }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole('menuitem', { name: 'Unlock schedule' }));
    expect(cmd.unlock).toHaveBeenCalled();
  });
});

describe('the keyboard', () => {
  it('one tab stop; ←/→ move between the buttons, Home/End to the ends', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">before</button>
        <Bar plan={makePlan()} cmd={commands()} />
        <button type="button">after</button>
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'before' }));
    await user.tab();
    expect(document.activeElement).toBe(button('Undo'));
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(button('Redo'));
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'More ▾' }));
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(button('Undo'));
    await user.keyboard('{ArrowRight}');
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'after' }));
    // back in: the button last used is the stop
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(button('Redo'));
  });

  it('a click hands focus back to the sheet; Enter on the button keeps it there', async () => {
    const user = userEvent.setup();
    const cmd = commands();
    render(<Bar plan={makePlan()} cmd={cmd} />);
    await user.click(button('Indent'));
    expect(cmd.indent).toHaveBeenCalledTimes(1);
    expect(cmd.focusSheet).toHaveBeenCalledTimes(1);
    button('Outdent').focus();
    await user.keyboard('{Enter}');
    expect(cmd.outdent).toHaveBeenCalledTimes(1);
    expect(cmd.focusSheet).toHaveBeenCalledTimes(1);
  });
});
