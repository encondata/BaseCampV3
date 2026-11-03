// @vitest-environment jsdom
/**
 * components/plans/PlanBoard: the Board view — Not started / In progress /
 * Complete, each with its count, the leaf tasks the filter shows as cards
 * (name, the summaries' path, Start → Finish, resources, a Late badge, the
 * deadline). Dragging a card to another column sets 0 / 50 / 100 % through
 * the tab's completion runner (so 100% meets the completion rules); a
 * card's actions menu does the same from the keyboard. Read-only people
 * (no `change`) can't move cards; a locked plan still takes progress.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Plan, PlanTask } from '../../lib/plans/api';
import { makePlan, makeTask } from '../../lib/plans/planFixtures';

// each card draws one actions menu, named for its task: its renders count the card's
const menus = vi.hoisted(() => ({ renders: {} as Record<string, number> }));
vi.mock('../hardware/RowActionsMenu', async (importActual) => {
  const actual = await importActual<typeof import('../hardware/RowActionsMenu')>();
  return {
    ...actual,
    RowActionsMenu: (props: Parameters<typeof actual.RowActionsMenu>[0]) => {
      const name = props.label ?? '';
      menus.renders[name] = (menus.renders[name] ?? 0) + 1;
      return actual.RowActionsMenu(props);
    },
  };
});

const { default: PlanBoard } = await import('./PlanBoard');

afterEach(cleanup);

const JIMMY = { kind: 'person' as const, id: 'p-me', name: 'Jimmy Henderson' };
const ACME = { kind: 'partner' as const, id: 'pt-1', name: 'Acme Movers' };

/**
 *  Prep (summary)
 *    Crating (summary)
 *      Wrap racks     40%, late, Jimmy + Acme, deadline Wed Nov 4
 *      Load crates    0%
 *    Order trucks     100%
 *  Move day           0%
 */
function tasks(): PlanTask[] {
  return [
    makeTask('s1', { is_summary: true, name: 'Prep' }),
    makeTask('s2', { is_summary: true, name: 'Crating', parent_id: 's1' }),
    makeTask('a', { name: 'Wrap racks', parent_id: 's2', percent_complete: 40, status: 'late',
      start: '2026-11-02T08:00', finish: '2026-11-03T17:00', assignees: [JIMMY, ACME],
      deadline: '2026-11-04T17:00' }),
    makeTask('b', { name: 'Load crates', parent_id: 's2' }),
    makeTask('c', { name: 'Order trucks', parent_id: 's1', percent_complete: 100, status: 'complete' }),
    makeTask('d', { name: 'Move day' }),
  ];
}
const plan = (over: Partial<Plan> = {}) => makePlan({ tasks: tasks(), ...over });

function renderBoard(p: Plan = plan(), opts: { rows?: string[]; selected?: Set<string> } = {}) {
  const run = vi.fn(async () => {});
  const onSelect = vi.fn();
  const onOpenInfo = vi.fn();
  const view = render(
    <PlanBoard plan={p} rows={opts.rows ?? p.tasks.map((t) => t.id)} context={new Set()}
               selected={opts.selected ?? new Set()} onSelect={onSelect} onOpenInfo={onOpenInfo}
               completion={{ run }} />,
  );
  return { ...view, run, onSelect, onOpenInfo };
}

const column = (name: string) => screen.getByRole('region', { name });
const card = (name: string) => screen.getByRole('group', { name });
const cardNames = (col: string) => within(column(col)).queryAllByRole('group').map((g) => g.getAttribute('aria-label'));

describe('PlanBoard', () => {
  it('three columns with their counts, the leaf tasks in outline order', () => {
    renderBoard();
    expect(cardNames('Not started')).toEqual(['Load crates', 'Move day']);
    expect(cardNames('In progress')).toEqual(['Wrap racks']);
    expect(cardNames('Complete')).toEqual(['Order trucks']);
    expect(within(column('Not started')).getByText('2').className).toContain('pln-board-count');
    expect(within(column('In progress')).getByText('1').className).toContain('pln-board-count');
  });

  it('a card shows its name, path, Start → Finish, resources, a Late badge and the deadline', () => {
    renderBoard();
    const c = card('Wrap racks');
    expect(within(c).getByText('Prep › Crating')).toBeTruthy();
    expect(within(c).getByText('Mon 11/2/26 → Tue 11/3/26')).toBeTruthy();
    expect(within(c).getByText('Jimmy Henderson, Acme Movers')).toBeTruthy();
    const late = within(c).getByText('Late');
    expect(late.className).toBe('chip c-red');
    expect(within(c).getByText('Deadline Wed 11/4/26')).toBeTruthy();
    // a top-level task has no path; no Late badge where the task isn't late
    expect(within(card('Move day')).queryByText('Late')).toBeNull();
  });

  it('dropping a card in Complete calls the completion runner with set_percent 100', () => {
    const { run } = renderBoard();
    fireEvent.dragStart(card('Wrap racks'));
    fireEvent.dragOver(column('Complete'));
    fireEvent.drop(column('Complete'));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith([{ op: 'set_percent', ids: ['a'], percent: 100 }], 'Move to Complete');
  });

  it('dropping in In progress sets 50, in Not started 0; a drop on its own column does nothing', () => {
    const { run } = renderBoard();
    fireEvent.dragStart(card('Load crates'));
    fireEvent.drop(column('Not started'));
    expect(run).not.toHaveBeenCalled();
    fireEvent.dragStart(card('Load crates'));
    fireEvent.dragOver(column('In progress'));
    fireEvent.drop(column('In progress'));
    expect(run).toHaveBeenLastCalledWith([{ op: 'set_percent', ids: ['b'], percent: 50 }], 'Move to In progress');
    fireEvent.dragStart(card('Order trucks'));
    fireEvent.drop(column('Not started'));
    expect(run).toHaveBeenLastCalledWith([{ op: 'set_percent', ids: ['c'], percent: 0 }], 'Move to Not started');
  });

  it('the column under a dragged card is marked as the drop target', () => {
    renderBoard();
    fireEvent.dragStart(card('Load crates'));
    fireEvent.dragOver(column('Complete'));
    expect(column('Complete').classList.contains('on')).toBe(true);
    fireEvent.dragEnd(card('Load crates'));
    expect(column('Complete').classList.contains('on')).toBe(false);
  });

  it('from the keyboard: the card’s menu moves it to another column', async () => {
    const user = userEvent.setup();
    const { run } = renderBoard();
    await user.click(within(card('Wrap racks')).getByRole('button', { name: 'Actions for Wrap racks' }));
    const items = screen.getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(['Move to Not started', 'Move to Complete', 'Task Information…']);
    await user.click(screen.getByRole('menuitem', { name: 'Move to Complete' }));
    expect(run).toHaveBeenCalledWith([{ op: 'set_percent', ids: ['a'], percent: 100 }], 'Move to Complete');
  });

  it('read-only: no dragging and no moves, Task Information only', async () => {
    const user = userEvent.setup();
    const { run } = renderBoard(plan({ permissions: { view: true, add: false, change: false, delete: false } }));
    expect(card('Wrap racks').getAttribute('draggable')).toBe('false');
    fireEvent.dragStart(card('Wrap racks'));
    fireEvent.drop(column('Complete'));
    expect(run).not.toHaveBeenCalled();
    await user.click(within(card('Wrap racks')).getByRole('button', { name: 'Actions for Wrap racks' }));
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Task Information…']);
  });

  it('a locked plan still takes progress: cards drag', () => {
    const { run } = renderBoard(plan({ locked_at: '2026-10-28T15:30:00Z' }));
    expect(card('Wrap racks').getAttribute('draggable')).toBe('true');
    fireEvent.dragStart(card('Wrap racks'));
    fireEvent.drop(column('Complete'));
    expect(run).toHaveBeenCalledWith([{ op: 'set_percent', ids: ['a'], percent: 100 }], 'Move to Complete');
  });

  it('a click selects the card’s task (Ctrl adds it), a double-click opens Task Information', async () => {
    const user = userEvent.setup();
    const { onSelect, onOpenInfo } = renderBoard();
    await user.click(within(card('Move day')).getByText('Move day'));
    expect(onSelect).toHaveBeenLastCalledWith('d', false);
    fireEvent.click(card('Load crates'), { metaKey: true });
    expect(onSelect).toHaveBeenLastCalledWith('b', true);
    await user.dblClick(card('Wrap racks'));
    expect(onOpenInfo).toHaveBeenCalledWith('a');
  });

  it('a selected card says so', () => {
    renderBoard(plan(), { selected: new Set(['a']) });
    expect(card('Wrap racks').classList.contains('on')).toBe(true);
    expect(within(card('Wrap racks')).getByRole('button', { name: 'Wrap racks' }).getAttribute('aria-pressed'))
      .toBe('true');
    expect(card('Move day').classList.contains('on')).toBe(false);
  });

  it('an empty column says so', () => {
    renderBoard(plan(), { rows: ['b', 'd'] });
    expect(within(column('Complete')).getByText('No tasks')).toBeTruthy();
  });
});

describe('a move from the keyboard', () => {
  it('focus follows the card to its new column, a polite note says so, and the next key is the board’s', async () => {
    const user = userEvent.setup();
    const p = plan();
    const moved = plan({ tasks: p.tasks.map((t) => (t.id === 'a' ? { ...t, percent_complete: 100, status: 'complete' } : t)) });
    const rows = p.tasks.map((t) => t.id);
    const props = { context: new Set<string>(), selected: new Set<string>(), onSelect: vi.fn(), onOpenInfo: vi.fn() };
    let redraw: (next: Plan) => void = () => {};
    // the plan merges before the write answers (usePlan's order)
    const run = vi.fn(async () => { redraw(moved); });
    const completion = { run };
    const view = render(<PlanBoard plan={p} rows={rows} completion={completion} {...props} />);
    redraw = (next) => view.rerender(<PlanBoard plan={next} rows={rows} completion={completion} {...props} />);
    await user.click(within(card('Wrap racks')).getByRole('button', { name: 'Actions for Wrap racks' }));
    await user.click(screen.getByRole('menuitem', { name: 'Move to Complete' }));
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('Actions for Wrap racks'));
    expect(within(column('Complete')).getByRole('group', { name: 'Wrap racks' }).contains(document.activeElement)).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('Moved Wrap racks to Complete');
  });

  it('a move that didn’t happen (stopped, refused) leaves no focus waiting for later', async () => {
    const user = userEvent.setup();
    const p = plan();
    const rows = p.tasks.map((t) => t.id);
    const props = { context: new Set<string>(), selected: new Set<string>(), onSelect: vi.fn(), onOpenInfo: vi.fn() };
    const completion = { run: vi.fn(async () => {}) };
    const view = render(<PlanBoard plan={p} rows={rows} completion={completion} {...props} />);
    await user.click(within(card('Wrap racks')).getByRole('button', { name: 'Actions for Wrap racks' }));
    await user.click(screen.getByRole('menuitem', { name: 'Move to Complete' }));
    await act(async () => {});
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    // later the task completes some other way: focus stays where the person is
    const later = plan({ tasks: p.tasks.map((t) => (t.id === 'a' ? { ...t, percent_complete: 100 } : t)) });
    view.rerender(<PlanBoard plan={later} rows={rows} completion={completion} {...props} />);
    expect(document.activeElement).toBe(outside);
    expect(screen.getByRole('status').textContent).toBe('');
    outside.remove();
  });
});

describe('a selection click redraws only the cards it changes', () => {
  it('picking a card redraws it alone; picking another redraws the two', () => {
    const p = plan();
    const rows = p.tasks.map((t) => t.id);
    const fixed = {
      plan: p, rows, context: new Set<string>(), onSelect: vi.fn(), onOpenInfo: vi.fn(), completion: { run: vi.fn() },
    };
    const view = render(<PlanBoard {...fixed} selected={new Set()} />);
    // which cards drew (a card's menu may draw more than once for one card render)
    const drawn = () => Object.keys(menus.renders).sort();
    menus.renders = {};
    view.rerender(<PlanBoard {...fixed} selected={new Set(['a'])} />);
    expect(drawn()).toEqual(['Actions for Wrap racks']);
    menus.renders = {};
    view.rerender(<PlanBoard {...fixed} selected={new Set(['d'])} />);
    expect(drawn()).toEqual(['Actions for Move day', 'Actions for Wrap racks']);
    // the board drawn again with the same selection redraws no card
    menus.renders = {};
    view.rerender(<PlanBoard {...fixed} selected={new Set(['d'])} />);
    expect(drawn()).toEqual([]);
  });
});

describe('the cards’ details', () => {
  it('a finish at midnight shows the day before', () => {
    renderBoard(plan({ tasks: [makeTask('n', { name: 'Night shift', start: '2026-11-03T20:00', finish: '2026-11-05T00:00' })] }));
    expect(within(card('Night shift')).getByText('Tue 11/3/26 → Wed 11/4/26')).toBeTruthy();
  });

  it('a drag carries the task under its own type, never as text', () => {
    renderBoard();
    const setData = vi.fn();
    fireEvent.dragStart(card('Wrap racks'), { dataTransfer: { setData, effectAllowed: 'all', dropEffect: 'none' } });
    expect(setData).toHaveBeenCalledWith('application/x-plan-task', 'a');
    expect(setData.mock.calls.some(([type]) => type === 'text/plain')).toBe(false);
  });
});

describe('a milestone on the Board', () => {
  const withMilestone = () => plan({
    tasks: [...tasks(), makeTask('m', { name: 'Go live', is_milestone: true, start: '2026-11-06T17:00',
      finish: '2026-11-06T17:00' })],
  });

  it('moves only between Not started and Complete: its menu, and the columns it can land in', async () => {
    const user = userEvent.setup();
    const { run } = renderBoard(withMilestone());
    await user.click(within(card('Go live')).getByRole('button', { name: 'Actions for Go live' }));
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Move to Complete', 'Task Information…']);
    await user.keyboard('{Escape}');
    fireEvent.dragStart(card('Go live'));
    fireEvent.dragOver(column('In progress'));
    expect(column('In progress').classList.contains('on')).toBe(false);
    fireEvent.drop(column('In progress'));
    expect(run).not.toHaveBeenCalled();
    fireEvent.dragStart(card('Go live'));
    fireEvent.drop(column('Complete'));
    expect(run).toHaveBeenCalledWith([{ op: 'set_percent', ids: ['m'], percent: 100 }], 'Move to Complete');
  });
});

describe('a card picked elsewhere', () => {
  it('scrolls into view within its column, never the page', () => {
    const p = plan();
    const rows = p.tasks.map((t) => t.id);
    const fixed = {
      plan: p, rows, context: new Set<string>(), onSelect: vi.fn(), onOpenInfo: vi.fn(), completion: { run: vi.fn() },
    };
    const intoView = vi.fn();
    const had = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = intoView;
    try {
      const view = render(<PlanBoard {...fixed} selected={new Set()} />);
      const box = column('Not started').querySelector('.pln-board-cards') as HTMLElement;
      const target = card('Move day');
      const rect = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 200, width: 200,
        height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
      box.getBoundingClientRect = () => rect(100, 300);
      target.getBoundingClientRect = () => rect(600, 690);
      view.rerender(<PlanBoard {...fixed} selected={new Set(['d'])} />);
      expect(box.scrollTop).toBe(390);
      expect(intoView).not.toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = had;
    }
  });
});
