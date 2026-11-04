// @vitest-environment jsdom
/**
 * components/plans/PlanToolbar.tsx: MS Project's ribbon groups in order,
 * a hover tip on every button (its name, the shortcut from the shortcut
 * table, what it does, why it's off) in place of a native title, who sees
 * what (read-only: Display, Gantt and More only), the locked plan's hint,
 * the Gantt layout control (Beside / Below / Hidden; Hidden turns the
 * chart-only commands off), the More menu, and the toolbar's one tab stop
 * with arrow keys between its buttons.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Plan } from '../../lib/plans/api';
import { COMMAND_TIPS, OFF_NOTES, moreDesc } from '../../lib/plans/commandTips';
import type { GanttLayout } from '../../lib/plans/ganttView';
import { makePlan, makeTask } from '../../lib/plans/planFixtures';
import { planShortcutKeys } from '../../lib/plans/shortcuts';
import { TIP_DELAY_MS } from '../Tip';
import PlanToolbar, { LOCKED_HINT, NO_BASELINE_HINT, useRovingToolbar } from './PlanToolbar';
import type { PlanCommands } from './usePlanCommands';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function commands(over: Partial<PlanCommands> = {}): PlanCommands {
  const fn = () => vi.fn();
  return {
    selected: [makeTask('a')], mode: 'auto', onTimeline: false,
    display: { critical: false, baseline: false }, zoom: 'days', finestZoom: 'fiveMinutes', chartScroll: null,
    goToTask: fn(), scrollChartTo: fn(), setBaseline: fn(),
    undo: fn(), redo: fn(), percent: fn(), markOnTrack: fn(), link: fn(), unlink: fn(), indent: fn(),
    outdent: fn(), setMode: fn(), insert: fn(), timeline: fn(), deleteTasks: fn(), confirmDelete: vi.fn(async () => {}),
    moveTasks: fn(),
    info: fn(), toggleCritical: fn(), toggleBaseline: fn(), zoomIn: fn(), zoomOut: fn(), fit: fn(), scrollToTask: fn(),
    collapse: fn(), expand: fn(), copy: vi.fn(() => true), cut: fn(), paste: fn(), lock: fn(), unlock: fn(), open: fn(),
    focusSheet: fn(), color: fn(), exportPlan: fn(), exportPdf: fn(), handlers: {}, grouped: false, cutMarks: new Set(),
    ...over,
  };
}

const CTL = { canUndo: true, canRedo: false, undoLabel: 'Indent', redoLabel: null };

function Bar({
  plan, cmd, layout = 'beside', onLayout = () => {}, gantt = true, strip = false, onStrip = () => {}, reports = true,
}: {
  plan: Plan; cmd: PlanCommands; layout?: GanttLayout; onLayout?: (layout: GanttLayout) => void;
  gantt?: boolean; strip?: boolean; onStrip?: () => void; reports?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useRovingToolbar(ref);
  return (
    <div role="toolbar" aria-label="Project plan" ref={ref}>
      <PlanToolbar plan={plan} ctl={CTL} commands={cmd} platform="win" layout={layout} onLayout={onLayout}
                   gantt={gantt} strip={strip} onStrip={onStrip} canReport={reports} />
    </div>
  );
}

const groups = () => within(screen.getByRole('toolbar')).getAllByRole('group').map((g) => g.getAttribute('aria-label'));
const button = (name: string) => screen.getByRole('button', { name });
/** A button's accessible name: its aria-label, else its text less what is aria-hidden (icons, More's ▾). */
function nameOf(el: HTMLElement): string {
  const label = el.getAttribute('aria-label');
  if (label !== null) return label;
  const copy = el.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
  return (copy.textContent ?? '').trim();
}

/** What a hover on `el` shows (fake timers): the tip's label, keycaps,
 *  description and note; the pointer then leaves. */
function hoverTip(el: HTMLElement) {
  fireEvent.pointerEnter(el);
  act(() => { vi.advanceTimersByTime(TIP_DELAY_MS); });
  const tip = screen.getByRole('tooltip');
  const read = {
    label: tip.querySelector('.tip-label')?.textContent ?? '',
    keys: [...tip.querySelectorAll('kbd')].map((k) => k.textContent),
    desc: tip.querySelector('.tip-desc')?.textContent ?? null,
    note: tip.querySelector('.tip-note')?.textContent ?? null,
  };
  fireEvent.pointerLeave(el);
  return read;
}

describe('groups', () => {
  it('shows MS Project’s groups in order; the Gantt Layout button ends Display', () => {
    render(<Bar plan={makePlan()} cmd={commands()} />);
    expect(groups()).toEqual(['Undo', 'Schedule', 'Tasks', 'Insert', 'Properties', 'Display']);
    expect(within(screen.getByRole('group', { name: 'Display' })).getAllByRole('button').map(nameOf))
      .toEqual(['Critical Path', 'Baseline', 'Timeline strip', 'Zoom Out', 'Zoom In', 'Fit Project', 'Scroll to Task',
        'Gantt Layout']);
    // after a separator, and no frame or caption of its own
    const layout = button('Gantt Layout');
    const seps = [...(layout.closest('.pln-tgroup-btns') as HTMLElement).querySelectorAll('.pln-tsep')];
    expect(seps.at(-1)?.compareDocumentPosition(layout)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.queryByRole('button', { name: 'Gantt' })).toBeNull();
    expect(within(screen.getByRole('group', { name: 'Schedule' })).getAllByRole('button').map((b) => b.getAttribute('aria-label')))
      .toEqual(['0% Complete', '25% Complete', '50% Complete', '75% Complete', '100% Complete', 'Mark on Track',
        'Link Tasks', 'Unlink Tasks', 'Outdent', 'Indent']);
    expect(screen.getByRole('button', { name: 'More' })).toBeTruthy();
  });

  it('read-only: only Display, the Gantt Layout in it (and More, with what a reader can use)', async () => {
    const user = userEvent.setup();
    render(<Bar plan={makePlan({ permissions: { view: true, add: false, change: false, delete: false } })}
                cmd={commands()} />);
    expect(groups()).toEqual(['Display']);
    expect(button('Gantt Layout')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Schedule' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Insert' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'More' }));
    // a reader exports (`view`), but doesn't import
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent))
      .toEqual(['MS Project XML', 'Excel', 'PDF…', 'Columns…', 'Keyboard shortcuts']);
  });

  it('locked: Indent and the other schedule changes are off, saying why; progress still works', () => {
    const cmd = commands();
    render(<Bar plan={makePlan({ locked_at: '2026-10-27T12:00:00Z' })} cmd={cmd} />);
    const indent = button('Indent');
    expect(indent.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(indent);
    expect(cmd.indent).not.toHaveBeenCalled();
    expect(button('Manually Schedule').getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button('50% Complete'));
    expect(cmd.percent).toHaveBeenCalledWith(50);
    fireEvent.click(button('Mark on Track'));
    expect(cmd.markOnTrack).toHaveBeenCalled();
  });

  it('nothing selected: the commands that need a task are off', () => {
    render(<Bar plan={makePlan()} cmd={commands({ selected: [], mode: null })} />);
    expect(button('Indent').getAttribute('aria-disabled')).toBe('true');
    expect(button('25% Complete').getAttribute('aria-disabled')).toBe('true');
    expect(button('Insert Task').getAttribute('aria-disabled')).toBeNull();     // above the blank row: at the end
  });

  it('Auto / Manual shows the selection’s mode and sets it', () => {
    const cmd = commands({ mode: 'manual' });
    render(<Bar plan={makePlan()} cmd={cmd} />);
    expect(button('Manually Schedule').getAttribute('aria-pressed')).toBe('true');
    expect(button('Manually Schedule').textContent).toBe('Manual');
    expect(button('Auto Schedule').getAttribute('aria-pressed')).toBe('false');
    expect(button('Auto Schedule').textContent).toBe('Auto');
    fireEvent.click(button('Auto Schedule'));
    expect(cmd.setMode).toHaveBeenCalledWith('auto');
  });

  it('Information and Notes open Task Information (Notes on its tab), even on a locked plan', () => {
    const cmd = commands();
    render(<Bar plan={makePlan({ locked_at: '2026-10-27T12:00:00Z' })} cmd={cmd} />);
    expect(button('Information').getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(button('Information'));
    expect(cmd.info).toHaveBeenLastCalledWith();
    fireEvent.click(button('Notes'));
    expect(cmd.info).toHaveBeenLastCalledWith('notes');
  });

  it('Task color, in Properties: on a locked plan too; its picker colors the selected tasks', () => {
    const cmd = commands({ selected: [makeTask('a'), makeTask('b', { color: '#1668a7' })] });
    render(<Bar plan={makePlan({ locked_at: '2026-10-27T12:00:00Z' })} cmd={cmd} />);
    const color = button('Task color');
    expect(color.closest('[role="group"]')?.getAttribute('aria-label')).toBe('Properties');
    expect(color.getAttribute('aria-disabled')).toBeNull();
    expect(color.getAttribute('aria-haspopup')).toBe('dialog');
    fireEvent.click(color);
    expect(color.getAttribute('aria-expanded')).toBe('true');
    const picker = screen.getByRole('dialog', { name: 'Task color' });
    // the two differ: neither shows as picked
    expect(within(picker).queryAllByRole('button', { pressed: true })).toEqual([]);
    fireEvent.click(within(picker).getByRole('button', { name: 'Green' }));
    expect(cmd.color).toHaveBeenCalledWith('#178a4c');
    expect(screen.queryByRole('dialog', { name: 'Task color' })).toBeNull();
    expect(color.getAttribute('aria-expanded')).toBe('false');
    // No color clears it
    fireEvent.click(color);
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Task color' })).getByRole('button', { name: 'No color' }));
    expect(cmd.color).toHaveBeenLastCalledWith(null);
  });

  it('Task color shows the color the selection shares; Escape closes its picker, back on the button', async () => {
    const user = userEvent.setup();
    const cmd = commands({ selected: [makeTask('a', { color: '#c03540' }), makeTask('b', { color: '#c03540' })] });
    render(<Bar plan={makePlan()} cmd={cmd} />);
    const color = button('Task color');
    color.focus();
    await user.keyboard('{Enter}');
    const picker = screen.getByRole('dialog', { name: 'Task color' });
    expect(within(picker).getByRole('button', { name: 'Red' }).getAttribute('aria-pressed')).toBe('true');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Task color' })).toBeNull();
    expect(document.activeElement).toBe(color);
    expect(cmd.color).not.toHaveBeenCalled();
  });

  it('Information and Notes need a task selected', () => {
    render(<Bar plan={makePlan()} cmd={commands({ selected: [], mode: null })} />);
    expect(button('Information').getAttribute('aria-disabled')).toBe('true');
    expect(button('Notes').getAttribute('aria-disabled')).toBe('true');
  });

  it('Display toggles show their state; zoom stops at the ends', () => {
    vi.useFakeTimers();
    const cmd = commands({ display: { critical: true, baseline: false }, zoom: 'fiveMinutes' });
    render(<Bar plan={makePlan()} cmd={cmd} />);
    expect(button('Critical Path').getAttribute('aria-pressed')).toBe('true');
    expect(button('Baseline').getAttribute('aria-pressed')).toBe('false');
    expect(button('Zoom In').getAttribute('aria-disabled')).toBe('true');
    expect(hoverTip(button('Zoom In')).note).toBe(OFF_NOTES.zoomedIn);
    fireEvent.click(button('Zoom Out'));
    expect(cmd.zoomOut).toHaveBeenCalled();
  });

  it('Zoom In keeps going past Hours', () => {
    const cmd = commands({ zoom: 'hours' });
    render(<Bar plan={makePlan()} cmd={cmd} />);
    expect(button('Zoom In').getAttribute('aria-disabled')).not.toBe('true');
    fireEvent.click(button('Zoom In'));
    expect(cmd.zoomIn).toHaveBeenCalled();
  });

  it('Zoom In stops at the finest step a long plan can draw', () => {
    vi.useFakeTimers();
    render(<Bar plan={makePlan()} cmd={commands({ zoom: 'wideHours', finestZoom: 'wideHours' })} />);
    expect(button('Zoom In').getAttribute('aria-disabled')).toBe('true');
    expect(hoverTip(button('Zoom In')).note).toBe(OFF_NOTES.zoomedIn);
  });
});

describe('hover tips', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('every button has a tip: its name, the keys from the shortcut table, what it does — no native title', () => {
    render(<Bar plan={makePlan()} cmd={commands()} />);
    const buttons = within(screen.getByRole('toolbar')).getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(25);
    expect(buttons.map(nameOf)).toContain('More');
    for (const b of buttons) {
      const name = nameOf(b);
      const tip = hoverTip(b);
      expect(tip.label, name).toBe(name);
      const entry = Object.values(COMMAND_TIPS).find((t) => t.label === tip.label);
      expect(entry, name).toBeDefined();
      const shortcut = entry && 'shortcut' in entry ? entry.shortcut : undefined;
      expect(tip.keys, name).toEqual(shortcut ? planShortcutKeys(shortcut, 'win').split(' or ') : []);
      expect(tip.desc, name).toBeTruthy();
      expect(b.hasAttribute('title'), name).toBe(false);
    }
  });

  it('shows the copy from the one table, and a Mac’s keys on a Mac', () => {
    render(<PlanToolbar plan={makePlan()} ctl={CTL} commands={commands({ selected: [makeTask('a'), makeTask('b')] })}
                        platform="mac" layout="beside" onLayout={() => {}} />);
    expect(hoverTip(button('Link Tasks'))).toEqual({
      label: 'Link Tasks', keys: ['⌘F2'], desc: COMMAND_TIPS.link.desc, note: null,
    });
    expect(COMMAND_TIPS.link.desc).toBe('Make each selected task follow the one before it (Finish-to-Start).');
    expect(hoverTip(button('Indent')).desc).toBe('Make the selected tasks subtasks of the task above.');
    expect(hoverTip(button('Mark on Track')).desc).toBe('Set progress to where the task should be as of the status date.');
    expect(hoverTip(button('Redo')).keys).toEqual(['⌘Y', '⌘⇧Z']);
  });

  it('Undo names the step it takes back; Redo with nothing to redo says so', () => {
    render(<Bar plan={makePlan()} cmd={commands()} />);
    const undo = hoverTip(button('Undo'));
    expect(undo.label).toBe('Undo');
    expect(undo.keys).toEqual(['Ctrl+Z']);
    expect(undo.desc).toContain('Indent');
    expect(undo.note).toBeNull();
    const redo = hoverTip(button('Redo'));
    expect(redo.keys).toEqual(['Ctrl+Y', 'Ctrl+Shift+Z']);
    expect(redo.note).toBe('Nothing to redo');
  });

  it('Task color: its tip from the one table; “Select a task first” with nothing selected', () => {
    const { rerender } = render(<Bar plan={makePlan()} cmd={commands()} />);
    expect(hoverTip(button('Task color'))).toEqual({
      label: 'Task color', keys: [], desc: 'Color the selected tasks’ bars on the Gantt chart.', note: null,
    });
    rerender(<Bar plan={makePlan()} cmd={commands({ selected: [], mode: null })} />);
    const off = button('Task color');
    expect(off.getAttribute('aria-disabled')).toBe('true');
    expect(hoverTip(off).note).toBe('Select a task first');
    fireEvent.click(off);
    expect(screen.queryByRole('dialog', { name: 'Task color' })).toBeNull();
  });

  it('a locked plan: the schedule changes say “Schedule is locked”; progress says nothing', () => {
    render(<Bar plan={makePlan({ locked_at: '2026-10-27T12:00:00Z' })} cmd={commands()} />);
    const indent = button('Indent');
    expect(indent.getAttribute('aria-disabled')).toBe('true');
    expect(hoverTip(indent)).toEqual({
      label: 'Indent', keys: ['Alt+Shift+→'], desc: 'Make the selected tasks subtasks of the task above.',
      note: 'Schedule is locked',
    });
    expect(LOCKED_HINT).toBe('Schedule is locked');
    for (const name of ['Link Tasks', 'Unlink Tasks', 'Outdent', 'Insert Task', 'Insert Summary Task', 'Insert Milestone',
      'Add to Timeline', 'Auto Schedule', 'Manually Schedule']) {
      expect(hoverTip(button(name)).note, name).toBe(LOCKED_HINT);
    }
    for (const name of ['50% Complete', 'Mark on Track', 'Information', 'Notes']) {
      expect(hoverTip(button(name)).note, name).toBeNull();
    }
  });

  it('grouped (Group by): Insert, Indent, Outdent, Link and Unlink say to turn it off; the rest work, locked still wins', () => {
    const two = [makeTask('a'), makeTask('b')];
    const { rerender } = render(<Bar plan={makePlan()} cmd={commands({ grouped: true, selected: two })} />);
    for (const name of ['Indent', 'Outdent', 'Insert Task', 'Insert Summary Task', 'Insert Milestone', 'Link Tasks',
      'Unlink Tasks']) {
      expect(button(name).getAttribute('aria-disabled'), name).toBe('true');
      expect(hoverTip(button(name)).note, name).toBe('Turn off Group by to change the outline');
    }
    for (const name of ['50% Complete', 'Information', 'Auto Schedule']) {
      expect(hoverTip(button(name)).note, name).toBeNull();
    }
    rerender(<Bar plan={makePlan({ locked_at: '2026-10-27T12:00:00Z' })} cmd={commands({ grouped: true })} />);
    expect(hoverTip(button('Indent')).note).toBe(LOCKED_HINT);
    expect(hoverTip(button('Insert Task')).note).toBe(LOCKED_HINT);
  });

  it('nothing selected: the commands that need a task say so; Link needs two', () => {
    render(<Bar plan={makePlan()} cmd={commands({ selected: [], mode: null })} />);
    expect(hoverTip(button('Indent')).note).toBe('Select a task first');
    expect(hoverTip(button('Information')).note).toBe('Select a task first');
    expect(hoverTip(button('Scroll to Task')).note).toBe('Select a task first');
    expect(hoverTip(button('Link Tasks')).note).toBe('Select two or more tasks');
    expect(hoverTip(button('Insert Task')).note).toBeNull();
  });

  it('More’s sentence names what it holds, Delete plan only for those who may delete', () => {
    const { unmount } = render(<Bar plan={makePlan()} cmd={commands()} />);
    expect(hoverTip(button('More')).desc).toBe(
      'Set or clear the baseline, update the project, lock the schedule, change plan settings, save the plan '
      + 'as a template, manage templates, import tasks from a file, export the plan to MS Project, Excel or PDF, '
      + 'choose the sheet’s columns, see the keyboard shortcuts, or delete the plan.');
    expect(COMMAND_TIPS.more.desc).toBe(moreDesc({ view: true, add: true, change: true, delete: true }));
    unmount();
    const noDelete = render(<Bar plan={makePlan({ permissions: { view: true, add: true, change: true, delete: false } })}
                                 cmd={commands()} />);
    expect(hoverTip(button('More')).desc).toBe(
      'Set or clear the baseline, update the project, lock the schedule, change plan settings, save the plan '
      + 'as a template, manage templates, import tasks from a file, export the plan to MS Project, Excel or PDF, '
      + 'choose the sheet’s columns, or see the keyboard shortcuts.');
    noDelete.unmount();
    const reader = render(<Bar plan={makePlan({ permissions: { view: true, add: false, change: false, delete: false } })}
                               cmd={commands()} />);
    expect(hoverTip(button('More')).desc).toBe(
      'Export the plan to MS Project, Excel or PDF, choose the sheet’s columns, or see the keyboard shortcuts.');
    reader.unmount();
    // a reader who may delete: the templates too (to delete them), the exports, the columns, the shortcuts and Delete plan
    render(<Bar plan={makePlan({ permissions: { view: true, add: false, change: false, delete: true } })}
                cmd={commands()} />);
    expect(hoverTip(button('More')).desc).toBe(
      'Manage templates, export the plan to MS Project, Excel or PDF, choose the sheet’s columns, see the keyboard '
      + 'shortcuts, or delete the plan.');
    vi.useRealTimers();
    fireEvent.click(button('More'));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent))
      .toEqual(['Templates…', 'MS Project XML', 'Excel', 'PDF…', 'Columns…', 'Keyboard shortcuts', 'Delete plan…']);
  });

  it('Save as template needs add; Templates… needs change or delete', () => {
    render(<Bar plan={makePlan({ permissions: { view: true, add: true, change: false, delete: false } })}
                cmd={commands()} />);
    expect(hoverTip(button('More')).desc).toBe(
      'Save the plan as a template, export the plan to MS Project, Excel or PDF, choose the sheet’s columns, or see '
      + 'the keyboard shortcuts.');
    vi.useRealTimers();
    fireEvent.click(button('More'));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent))
      .toEqual(['Save as template…', 'MS Project XML', 'Excel', 'PDF…', 'Columns…', 'Keyboard shortcuts']);
  });

  it('the More trigger’s tip says what it holds, and goes once its menu opens', () => {
    render(<Bar plan={makePlan()} cmd={commands()} />);
    const more = button('More');
    fireEvent.pointerEnter(more);
    act(() => { vi.advanceTimersByTime(TIP_DELAY_MS); });
    expect(screen.getByRole('tooltip').querySelector('.tip-label')?.textContent).toBe('More');
    // the tip describes the trigger while it shows
    expect(more.getAttribute('aria-describedby')).toBe(screen.getByRole('tooltip').id);
    fireEvent.pointerDown(more);
    fireEvent.click(more);
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.queryByRole('tooltip')).toBeNull();
    // resting on it with the menu open shows nothing over the menu
    fireEvent.pointerLeave(more);
    fireEvent.pointerEnter(more);
    act(() => { vi.advanceTimersByTime(TIP_DELAY_MS); });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('the Gantt layout', () => {
  it('one icon button, its icon the layout now; a menu of Beside, Below and Hidden, the current one checked', async () => {
    const user = userEvent.setup();
    const onLayout = vi.fn();
    const cmd = commands();
    const { rerender } = render(<Bar plan={makePlan()} cmd={cmd} layout="below" onLayout={onLayout} />);
    const trigger = button('Gantt Layout');
    expect(trigger.className).toBe('mini-btn pln-tbtn');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.querySelector('svg')?.getAttribute('data-layout')).toBe('below');
    await user.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((i) => i.getAttribute('aria-label'))).toEqual(['Beside', 'Below', 'Hidden']);
    expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    // each says what it does
    expect(items.map((i) => i.querySelector('.pop-item-hint')?.textContent)).toEqual([
      'Show the Gantt chart beside the task sheet.',
      'Show the Gantt chart under the task sheet — for narrower screens; Full screen gives it the most room.',
      'Hide the Gantt chart and show only the task sheet.',
    ]);
    // a choice is passed up; focus goes back to the button, not the sheet (with
    // nothing selected that would select the first row and scroll up to it)
    await user.click(screen.getByRole('menuitemradio', { name: 'Hidden' }));
    expect(onLayout).toHaveBeenCalledWith('hidden');
    expect(cmd.focusSheet).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button('Gantt Layout'));
    expect(screen.queryByRole('menu')).toBeNull();
    // the icon follows the layout
    rerender(<Bar plan={makePlan()} cmd={cmd} layout="hidden" onLayout={onLayout} />);
    expect(button('Gantt Layout').querySelector('svg')?.getAttribute('data-layout')).toBe('hidden');
    rerender(<Bar plan={makePlan()} cmd={cmd} layout="beside" onLayout={onLayout} />);
    expect(button('Gantt Layout').querySelector('svg')?.getAttribute('data-layout')).toBe('beside');
  });

  it('from the keyboard: Enter opens it on the current layout, ↓ moves, Enter picks Below; focus comes back', async () => {
    const user = userEvent.setup();
    const onLayout = vi.fn();
    const cmd = commands();
    render(<Bar plan={makePlan()} cmd={cmd} layout="beside" onLayout={onLayout} />);
    act(() => { button('Gantt Layout').focus(); });
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Beside' }));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Below' }));
    await user.keyboard('{Enter}');
    expect(onLayout).toHaveBeenCalledWith('below');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button('Gantt Layout'));
    expect(cmd.focusSheet).not.toHaveBeenCalled();
  });

  it('More from the keyboard: Enter opens it on its first item, ↑ wraps to the last, Escape comes back', async () => {
    const user = userEvent.setup();
    const cmd = commands();
    render(<Bar plan={makePlan({ baseline_set_at: '2026-10-20T10:00:00Z' })} cmd={cmd} />);
    act(() => { button('More').focus(); });
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Set baseline…' }));
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Delete plan…' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button('More'));
    // ↓ opens it too, and Enter on an item runs it
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{Enter}');
    expect(cmd.open).toHaveBeenLastCalledWith('updateProject');
  });

  it('its tip names it "Gantt Layout" and says what it does', () => {
    vi.useFakeTimers();
    render(<Bar plan={makePlan()} cmd={commands()} />);
    expect(hoverTip(button('Gantt Layout'))).toEqual({
      label: 'Gantt Layout', keys: [], note: null,
      desc: 'Choose where the Gantt chart goes: beside the sheet, below it, or hidden.',
    });
  });

  it('Hidden: the chart-only commands are off, saying to show the chart; the rest work', () => {
    vi.useFakeTimers();
    const cmd = commands();
    render(<Bar plan={makePlan()} cmd={cmd} layout="hidden" />);
    for (const name of ['Critical Path', 'Baseline', 'Zoom Out', 'Zoom In', 'Fit Project', 'Scroll to Task']) {
      const b = button(name);
      expect(b.getAttribute('aria-disabled'), name).toBe('true');
      expect(hoverTip(b).note, name).toBe(OFF_NOTES.noChart);
    }
    expect(OFF_NOTES.noChart).toBe('Show the Gantt chart to use this');
    fireEvent.click(button('Fit Project'));
    expect(cmd.fit).not.toHaveBeenCalled();
    fireEvent.click(button('Indent'));
    expect(cmd.indent).toHaveBeenCalled();
  });

  it('Hidden: the Timeline strip still toggles (it isn’t the chart’s)', () => {
    const onStrip = vi.fn();
    render(<Bar plan={makePlan()} cmd={commands()} layout="hidden" strip onStrip={onStrip} />);
    expect(button('Timeline strip').getAttribute('aria-disabled')).toBeNull();
    expect(button('Timeline strip').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button('Timeline strip'));
    expect(onStrip).toHaveBeenCalledTimes(1);
  });

  it('outside the Gantt view: the chart-only commands, the strip and Gantt Layout are off, saying to switch', () => {
    vi.useFakeTimers();
    const cmd = commands();
    const onLayout = vi.fn();
    const onStrip = vi.fn();
    render(<Bar plan={makePlan()} cmd={cmd} gantt={false} onLayout={onLayout} onStrip={onStrip} />);
    for (const name of ['Critical Path', 'Baseline', 'Timeline strip', 'Zoom Out', 'Zoom In', 'Fit Project',
      'Scroll to Task', 'Gantt Layout']) {
      const b = button(name);
      expect(b.getAttribute('aria-disabled'), name).toBe('true');
      expect(hoverTip(b).note, name).toBe(OFF_NOTES.ganttOnly);
    }
    // Gantt Layout keeps its tip and its icon, but opens no menu
    expect(hoverTip(button('Gantt Layout')).desc).toBe(COMMAND_TIPS.layout.desc);
    expect(button('Gantt Layout').hasAttribute('aria-haspopup')).toBe(false);
    fireEvent.click(button('Gantt Layout'));
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(button('Timeline strip'));
    fireEvent.click(button('Zoom In'));
    expect(onStrip).not.toHaveBeenCalled();
    expect(cmd.zoomIn).not.toHaveBeenCalled();
    // the selection's commands still work
    fireEvent.click(button('100% Complete'));
    expect(cmd.percent).toHaveBeenCalledWith(100);
  });
});

describe('More', () => {
  it('lists the plan commands, each opening its dialog; the menu sits above full screen', async () => {
    const user = userEvent.setup();
    const cmd = commands();
    render(<Bar plan={makePlan({ baseline_set_at: '2026-10-20T10:00:00Z' })} cmd={cmd} />);
    await user.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getAllByRole('menuitem').map((m) => m.firstChild?.textContent)).toEqual([
      'Set baseline…', 'Clear baseline…', 'Update project…', 'Lock schedule…', 'Plan settings…',
      'Save as template…', 'Templates…', 'Import…', 'MS Project XML', 'Excel', 'PDF…', 'Columns…', 'Keyboard shortcuts',
      'Delete plan…',
    ]);
    const menu = document.querySelector('.pop-menu') as HTMLElement;
    expect(Number(menu.style.zIndex)).toBeGreaterThan(60);
    await user.click(screen.getByRole('menuitem', { name: 'Set baseline…' }));
    expect(cmd.setBaseline).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'More' }));
    await user.click(screen.getByRole('menuitem', { name: 'Lock schedule…' }));
    expect(cmd.lock).toHaveBeenCalled();
    for (const [item, kind] of [['Clear baseline…', 'clearBaseline'], ['Update project…', 'updateProject'],
      ['Plan settings…', 'settings'], ['Delete plan…', 'deletePlan'], ['Columns…', 'columns'],
      ['Save as template…', 'saveTemplate'], ['Templates…', 'templates'], ['Import…', 'import']] as const) {
      await user.click(screen.getByRole('button', { name: 'More' }));
      await user.click(screen.getByRole('menuitem', { name: item }));
      expect(cmd.open).toHaveBeenLastCalledWith(kind);
    }
  });

  it('Export: MS Project XML, Excel and PDF… under one titled group', async () => {
    const user = userEvent.setup();
    const cmd = commands();
    render(<Bar plan={makePlan()} cmd={cmd} />);
    await user.click(screen.getByRole('button', { name: 'More' }));
    const group = screen.getByRole('group', { name: COMMAND_TIPS.exportGroup.label });
    expect(within(group).getAllByRole('menuitem').map((m) => m.textContent))
      .toEqual([COMMAND_TIPS.exportXml.label, COMMAND_TIPS.exportXlsx.label, COMMAND_TIPS.exportPdf.label]);
    await user.click(within(group).getByRole('menuitem', { name: 'Excel' }));
    expect(cmd.exportPlan).toHaveBeenLastCalledWith('xlsx');
    await user.click(screen.getByRole('button', { name: 'More' }));
    await user.click(screen.getByRole('menuitem', { name: 'MS Project XML' }));
    expect(cmd.exportPlan).toHaveBeenLastCalledWith('xml');
    // PDF… opens the report's options (the file comes from the report worker)
    await user.click(screen.getByRole('button', { name: 'More' }));
    await user.click(screen.getByRole('menuitem', { name: 'PDF…' }));
    expect(cmd.exportPdf).toHaveBeenCalledTimes(1);
    expect(COMMAND_TIPS.exportPdf.desc).toBe('Make a PDF of the task table and the Gantt chart on separate pages.');
  });

  it('PDF… is off, saying why, for someone who can’t run reports', async () => {
    const user = userEvent.setup();
    const cmd = commands();
    render(<Bar plan={makePlan()} cmd={cmd} reports={false} />);
    await user.click(screen.getByRole('button', { name: 'More' }));
    const item = screen.getByRole('menuitem', { name: /^PDF…/ }) as HTMLButtonElement;
    expect(item.disabled).toBe(true);
    expect(item.textContent).toContain(OFF_NOTES.noReports);
    expect(OFF_NOTES.noReports).toBe('Needs access to Reports');
    await user.click(item);
    expect(cmd.exportPdf).not.toHaveBeenCalled();
    // the downloads are the plan's own: still on
    expect((screen.getByRole('menuitem', { name: 'Excel' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a read-only person still has Export › PDF…', async () => {
    const user = userEvent.setup();
    const cmd = commands();
    render(<Bar plan={makePlan({ permissions: { view: true, add: false, change: false, delete: false } })} cmd={cmd} />);
    await user.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('menuitem', { name: 'PDF…' })).toBeTruthy();
  });

  it('Import… needs change and an unlocked schedule; a locked plan still exports', async () => {
    const user = userEvent.setup();
    const cmd = commands();
    const locked = render(<Bar plan={makePlan({ locked_at: '2026-10-27T12:00:00Z' })} cmd={cmd} />);
    await user.click(screen.getByRole('button', { name: 'More' }));
    const item = screen.getByRole('menuitem', { name: 'Import…' }) as HTMLButtonElement;
    expect(item.disabled).toBe(true);
    expect(item.textContent).toContain(LOCKED_HINT);
    expect((screen.getByRole('menuitem', { name: 'Excel' }) as HTMLButtonElement).disabled).toBe(false);
    locked.unmount();
    // add without change: no Import… (a file goes into an existing plan as a change)
    render(<Bar plan={makePlan({ permissions: { view: true, add: true, change: false, delete: false } })} cmd={cmd} />);
    await user.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.queryByRole('menuitem', { name: 'Import…' })).toBeNull();
  });

  it('no baseline yet: Clear baseline is off, saying why', async () => {
    const user = userEvent.setup();
    render(<Bar plan={makePlan({ baseline_set_at: null })} cmd={commands()} />);
    await user.click(screen.getByRole('button', { name: 'More' }));
    const clear = screen.getByRole('menuitem', { name: 'Clear baseline…' }) as HTMLButtonElement;
    expect(clear.disabled).toBe(true);
    expect(clear.textContent).toContain(NO_BASELINE_HINT);
  });

  it('a locked plan offers Unlock schedule; the baseline waits for it, Update project doesn’t', async () => {
    const user = userEvent.setup();
    const cmd = commands();
    render(<Bar plan={makePlan({ locked_at: '2026-10-27T12:00:00Z' })} cmd={cmd} />);
    await user.click(screen.getByRole('button', { name: 'More' }));
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
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'More' }));
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(button('Undo'));
    await user.keyboard('{ArrowRight}');
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'after' }));
    // back in: the button last used is the stop
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(button('Redo'));
  });

  it('the tips’ wrappers take no stop: every button is one, each showing its tip as the arrows reach it', async () => {
    const user = userEvent.setup();
    render(<Bar plan={makePlan()} cmd={commands()} />);
    const bar = screen.getByRole('toolbar');
    const buttons = within(bar).getAllByRole('button');
    expect(bar.querySelectorAll('.tip-trigger').length).toBe(buttons.length);
    // one tab stop, and no wrapper is focusable
    expect(buttons.filter((b) => b.tabIndex === 0)).toHaveLength(1);
    expect([...bar.querySelectorAll('.tip-trigger')].some((w) => w.hasAttribute('tabindex'))).toBe(false);
    act(() => { buttons[0].focus(); });
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(button('More'));
    // back along every button: each the stop in turn, its tip showing
    for (let i = buttons.length - 2; i >= 0; i -= 1) {
      await user.keyboard('{ArrowLeft}');
      expect(document.activeElement, nameOf(buttons[i])).toBe(buttons[i]);
      expect(buttons[i].tabIndex).toBe(0);
      expect(screen.getByRole('tooltip').querySelector('.tip-label')?.textContent).toBe(nameOf(buttons[i]));
    }
    // and round to the end
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(button('More'));
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);
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
