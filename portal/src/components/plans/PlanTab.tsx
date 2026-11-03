/**
 * The initiative's Project plan tab: the host every plan surface plugs
 * into. It owns the PlanController (usePlan), the URL state, full screen
 * and the open dialog, and lays out three slots:
 *
 *  - the toolbar slot: `.pln-toolbar` (role="toolbar", one tab stop, ←/→
 *    between its buttons) holds the view switcher at the left (one menu
 *    button named by the view on, "Gantt ▾": spec amendment 2026-11-03, so
 *    the toolbar keeps to one line at 1512px with the nav open; Full screen
 *    is an icon button for the same reason),
 *    PlanToolbar's groups in `.pln-tools` and Full screen at the right;
 *    beside it, outside the toolbar, the initiative's name in full screen
 *    and the "Plan updated by…" status. The commands, the MS Project
 *    keyboard map and the clipboard are usePlanCommands' and
 *    usePlanShortcuts'. Under it the filter bar (PlanFilterBar: Filter,
 *    Group by in the Gantt view, the search; Ctrl+F focuses the search);
 *  - the view area (`.pln-view`): the Gantt view — the task sheet and the
 *    chart in the layout the toolbar's Gantt group picks (GanttPanes: side
 *    by side in one vertical scroll box, `scrollRef`, both panes
 *    virtualize against; stacked, each in a box of its own kept on the
 *    same row; or the sheet alone), each pane with its own sideways scroll
 *    (SidePane: the design is in Splitter.tsx), with the Timeline strip
 *    (PlanTimelineStrip, Display › Timeline strip, kept per plan in
 *    localStorage `plans.strip.<planId>`) as the area's top band when it is
 *    on (the area keeps its floor, and the page never scrolls for it); the
 *    Calendar (PlanCalendar) and the Board (PlanBoard) take the whole area.
 *    All three show the filter bar's tasks (Group by is the Gantt's alone,
 *    and so is collapse) and share the selection: a task picked in the
 *    Calendar, the Board or the strip is the sheet's selected row, and the
 *    toolbar's commands work on it in every view. Outside the Gantt the
 *    chart-only commands, the strip and Gantt Layout are off, and of the
 *    keyboard map only the keys that don't need the sheet stay (Undo,
 *    Redo, Task Information, Find, the shortcuts list);
 *  - the dialogs host: one PlanModal-based dialog at a time (`PlanDialog`;
 *    one from More that closes with nothing under it hands focus back to
 *    the sheet, quietly), and over it the completion check (useCompletion: every 100% path,
 *    Task Information's and Update project's too, ends there). The check
 *    reaches the sheet and the chart through CompletionContext; its Go to
 *    task selects the task and scrolls it into view in both.
 *
 * The Gantt view's shared state lives here too (useSheetView.ts): the rows on
 * screen (the outline less collapsed subtasks, filtered and maybe grouped;
 * collapse state per plan in localStorage `plans.collapsed.<planId>`, the
 * filter bar's in `plans.view.<planId>`), the selection, and the row
 * height (the list size).
 *
 * URL state lives beside `?tab=plan`: `&view=gantt|calendar|board` (Gantt
 * by default; anything else reads as Gantt) and `&task=<id>` (reminder
 * emails link to it): once the plan loads, that task's collapsed summaries
 * open, its row is selected and
 * scrolled into view, and the chart scrolls to its bar; an id the plan
 * doesn't have is ignored.
 *
 * Full screen fills the viewport above the portal chrome, which goes
 * inert meanwhile (Tab stays in the plan); Escape leaves it unless a
 * dialog or menu is open (Escape closes that first) or an editor has
 * focus (Escape cancels the edit).
 */

import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject,
} from 'react';
import { useSearchParams } from 'react-router-dom';

import { useAuth } from '../../auth/AuthContext';
import { longDate } from '../../lib/format';
import { listScale } from '../../lib/listTools';
import { useToast } from '../../lib/notificationsContext';
import type { Plan, PlanTask } from '../../lib/plans/api';
import { SHEET_ROW_PX } from '../../lib/plans/columns';
import { COMMAND_TIPS, tipKeys, type CommandTipId } from '../../lib/plans/commandTips';
import { canAddTasks } from '../../lib/plans/editOps';
import { isPlanChanged, planErrorText } from '../../lib/plans/errors';
import { readStrip, writeStrip } from '../../lib/plans/ganttView';
import { selectCell, toggleRow } from '../../lib/plans/selection';
import { settleSelection } from '../../lib/plans/viewRows';
import { detectPlatform } from '../../lib/plans/shortcuts';
import { RowActionsMenu } from '../hardware/RowActionsMenu';
import Tip from '../Tip';
import ColumnsModal from './ColumnsModal';
import DeletePlanModal from './DeletePlanModal';
import DeleteTasksModal from './DeleteTasksModal';
import GanttPanes, { useGanttLayout } from './GanttPanes';
import PlanBoard from './PlanBoard';
import PlanCalendar from './PlanCalendar';
import { ClearBaselineModal, LockModal, ReplaceBaselineModal } from './PlanConfirmModals';
import PlanCreateModal, { type PlanInitiative } from './PlanCreateModal';
import PlanEmptyState from './PlanEmptyState';
import PlanFilterBar from './PlanFilterBar';
import PlanGantt from './PlanGantt';
import PlanSettingsModal from './PlanSettingsModal';
import PlanSheet from './PlanSheet';
import PlanTimelineStrip from './PlanTimelineStrip';
import PlanToolbar, { useRovingToolbar } from './PlanToolbar';
import ShortcutsModal from './ShortcutsModal';
import TaskDependencyModal from './TaskDependencyModal';
import TaskInfoModal from './TaskInfoModal';
import UpdateProjectModal from './UpdateProjectModal';
import { CompletionContext, useCompletion } from './useCompletion';
import { usePlan, type PlanController } from './usePlan';
import { usePlanCommands, type PlanDialog } from './usePlanCommands';
import { usePlanShortcuts, type PlanShortcutHandlers } from './usePlanShortcuts';
import { useSheetView } from './useSheetView';

import '../../styles/plans.css';

export type PlanViewKey = 'gantt' | 'calendar' | 'board';

/** The views the switcher offers, with their tips (lib/plans/commandTips). */
const PLAN_VIEWS: readonly { key: PlanViewKey; tip: CommandTipId }[] = [
  { key: 'gantt', tip: 'viewGantt' },
  { key: 'calendar', tip: 'viewCalendar' },
  { key: 'board', tip: 'viewBoard' },
];

/** `?view=` as one of the views on offer; anything else is the Gantt. */
function readView(param: string | null): PlanViewKey {
  return PLAN_VIEWS.find((v) => v.key === param)?.key ?? 'gantt';
}

/** Display › Timeline strip for the plan on screen: kept per plan in this
 *  browser (`plans.strip.<planId>`, off until turned on; storage that
 *  refuses keeps the choice for this visit). */
function usePlanStrip(planId: string | null): [boolean, () => void] {
  const stored = useMemo(() => readStrip(planId), [planId]);
  const [picked, setPicked] = useState<{ planId: string; on: boolean } | null>(null);
  const on = picked && picked.planId === planId ? picked.on : stored;
  const toggle = useCallback(() => {
    if (!planId) return;
    setPicked({ planId, on: !on });
    writeStrip(planId, !on);
  }, [planId, on]);
  return [on, toggle];
}

/** The keys that work in every view: none of them needs the sheet. */
const VIEW_KEYS = ['undo', 'redo', 'info', 'find', 'help'] as const;

/** The keyboard map for the view: the whole of it in the Gantt, VIEW_KEYS
 *  elsewhere, where Task Information (Shift+F2) opens the focused bar's or
 *  card's task (`focusedTask`) ahead of the selection. */
function keysFor(handlers: PlanShortcutHandlers, gantt: boolean,
  focusedTask: () => string | null, open: (taskId: string) => void): PlanShortcutHandlers {
  if (gantt) return handlers;
  const keys: PlanShortcutHandlers = Object.fromEntries(
    VIEW_KEYS.filter((k) => handlers[k]).map((k) => [k, handlers[k]]));
  const info = handlers.info;
  keys.info = (e) => {
    const id = focusedTask();
    if (!id) return info ? info(e) : false;
    open(id);
    return true;
  };
  return keys;
}

/** The view area never gets shorter than this. */
const MIN_VIEW_PX = 320;

/** The view area's height on the page: from where it starts down to the
 *  bottom of the scrolling main column (.portal-main), less what the page
 *  puts below it (margins, the page's bottom padding), so the sheet and
 *  the chart scroll inside it while the page itself stays put. Measured
 *  again whenever the column or the page changes size (a window resize,
 *  the lock banner coming and going); null when off (full screen lays the
 *  area out with flex instead) or when there is no main column (the CSS
 *  fallback height applies). */
function useFillHeight(ref: RefObject<HTMLElement | null>, on: boolean): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const scroller = el?.closest<HTMLElement>('.portal-main') ?? null;
    if (!on || !el || !scroller) {
      setHeight(null);
      return undefined;
    }
    const page = el.closest<HTMLElement>('.portal-page');
    const measure = () => {
      const box = el.getBoundingClientRect();
      const top = box.top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      // what follows the area inside the page doesn't depend on its height
      const below = page ? Math.max(0, page.getBoundingClientRect().bottom - box.bottom) : 0;
      setHeight(Math.max(MIN_VIEW_PX, Math.floor(scroller.clientHeight - top - below)));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    if (page) observer.observe(page);
    return () => observer.disconnect();
  }, [ref, on]);
  return height;
}

/** What stays live behind full screen: the toasts, whose actions (Undo,
 *  Open) still have to be reachable, and an open More menu (portaled into
 *  the shell, it sits above full screen). */
const KEEP_LIVE = '.toast-host, .pop-menu';

/** While `on`, everything in the shell outside `ref` — the nav, the top
 *  bar, the page header and tabs — is `inert`, so neither Tab nor a click
 *  reaches what full screen covers. Each sibling along the path from the
 *  tab root up to `.portal-shell` (document.body without one) is marked;
 *  an element some other surface already made inert is left to it. The
 *  marks come off on exit and on unmount. */
function useInertOutside(ref: RefObject<HTMLElement | null>, on: boolean): void {
  useEffect(() => {
    const root = ref.current;
    if (!on || !root) return undefined;
    const top = root.closest('.portal-shell') ?? document.body;
    const marked: Element[] = [];
    for (let node: Element = root; node !== top && node.parentElement; node = node.parentElement) {
      for (const sibling of Array.from(node.parentElement.children)) {
        if (sibling === node || sibling.hasAttribute('inert') || sibling.matches(KEEP_LIVE)) continue;
        sibling.setAttribute('inert', '');
        marked.push(sibling);
      }
    }
    return () => {
      for (const el of marked) el.removeAttribute('inert');
    };
  }, [ref, on]);
}

/** The dialogs More opens (and Set baseline's replace question). */
const MORE_DIALOGS: ReadonlySet<PlanDialog['kind']> = new Set<PlanDialog['kind']>([
  'columns', 'shortcuts', 'replaceBaseline', 'clearBaseline', 'lock', 'updateProject', 'settings', 'deletePlan',
]);

/** A dialog from More that closes with no dialog under it hands focus back
 *  to the sheet when it fell to the page (its opener, the menu item, is
 *  gone): quietly, so nothing is selected and the sheet doesn't scroll. */
function useFocusBackAfter(dialog: PlanDialog | null, focusSheet: () => void): void {
  const shown = useRef<PlanDialog | null>(null);
  useEffect(() => {
    const was = shown.current;
    shown.current = dialog;
    if (dialog || !was || !MORE_DIALOGS.has(was.kind)) return undefined;
    // after the dialog's own focus return, which ran as it unmounted
    const id = window.setTimeout(() => {
      const focus = document.activeElement;
      if ((focus === null || focus === document.body) && !document.querySelector('.modal-scrim')) focusSheet();
    }, 0);
    return () => window.clearTimeout(id);
  }, [dialog, focusSheet]);
}

/** Where Escape belongs to someone else: a dialog or an open menu takes it
 *  first, and inside a field it cancels the edit. */
function escapeTakenElsewhere(e: KeyboardEvent): boolean {
  if (e.defaultPrevented) return true;
  if (document.querySelector('.modal-scrim, [role="menu"]')) return true;
  const target = e.target as Element | null;
  return !!target && typeof target.closest === 'function'
    && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
}

export default function PlanTab({ initiativeId, initiative }: {
  initiativeId: string;
  initiative: PlanInitiative;
}) {
  const ctl = usePlan(initiativeId);
  const { can, preferences, person } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = readView(searchParams.get('view'));
  const [fullScreen, setFullScreen] = useState(false);
  const [dialog, setDialog] = useState<PlanDialog | null>(null);
  const closeDialog = useCallback(() => setDialog(null), []);

  const ready = ctl.status === 'ready' && ctl.plan !== null;
  const isFull = fullScreen && ready;
  const rootRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const viewHeight = useFillHeight(viewRef, ready && !isFull);
  useInertOutside(rootRef, isFull);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sheetSideRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const clipRef = useRef<HTMLTextAreaElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const rowHeight = Math.round(SHEET_ROW_PX * listScale(preferences?.list_size));
  // the deep link's bar in the chart: the commands' (they come after the view)
  const linkedRef = useRef<(taskId: string) => void>(() => {});
  const onLinked = useCallback((taskId: string) => linkedRef.current(taskId), []);
  const gantt = view === 'gantt';
  const sheet = useSheetView(ctl, searchParams.get('task'), scrollRef, rowHeight, {
    me: person?.id ?? '', groupable: gantt, collapsible: gantt, onLinked,
  });
  // the completion check's Go to task: the commands' (they come after it)
  const goToRef = useRef<(taskId: string) => void>(() => {});
  const completion = useCompletion(ctl, { onGoTo: (taskId) => goToRef.current(taskId) });
  const [layout, setLayout] = useGanttLayout();
  const commands = usePlanCommands({
    ctl, sheet: sheet.forCommands, root: rootRef, clip: clipRef, openDialog: setDialog, completion, layout,
    searchBox: searchRef,
  });
  useLayoutEffect(() => {
    goToRef.current = commands.goToTask;
    linkedRef.current = commands.scrollChartTo;
  });
  useRovingToolbar(toolbarRef, ready);
  const { scheduled_start: scheduledStart, scheduled_end: scheduledEnd } = initiative;
  const scheduled = useMemo(() => ({ start: scheduledStart, end: scheduledEnd }), [scheduledStart, scheduledEnd]);
  const { zoomIn, zoomOut, focusSheet } = commands;
  const zoomStep = useCallback((dir: -1 | 1) => (dir < 0 ? zoomIn() : zoomOut()), [zoomIn, zoomOut]);
  useFocusBackAfter(dialog, focusSheet);
  // the chart's link click and bar double-click, the sheet's double-click
  // on a cell that doesn't edit (a row's number): Task Dependency, Task Information
  const openLink = useCallback((linkId: string) => setDialog({ kind: 'dependency', linkId }), []);
  const openTaskInfo = useCallback((task: PlanTask) => setDialog({ kind: 'taskInfo', taskId: task.id }), []);
  const openTaskInfoById = useCallback((taskId: string) => setDialog({ kind: 'taskInfo', taskId }), []);
  // the task of the bar or card with focus, in the tab
  const focusedTask = useCallback((): string | null => {
    const el = document.activeElement;
    if (!(el instanceof Element) || !rootRef.current?.contains(el)) return null;
    return el.closest('[data-task-id]')?.getAttribute('data-task-id') ?? null;
  }, []);
  const keys = useMemo(() => keysFor(commands.handlers, gantt, focusedTask, openTaskInfoById),
    [commands.handlers, gantt, focusedTask, openTaskInfoById]);
  usePlanShortcuts(keys, { root: rootRef, enabled: ready });
  const { rows: shownRows, context: contextRows, bands: bandRows, select: selectRows } = sheet;
  // outside the Gantt, the tasks the view draws: leaf tasks the filter keeps
  // (the Calendar, those with a start); the selection is settled to them, so
  // the toolbar's commands act on what is on screen (a summary picked in the
  // Gantt doesn't ride along into the Board)
  const planTasks = ctl.plan?.tasks;
  const drawn = useMemo(() => {
    if (gantt || !planTasks) return null;
    const byId = new Map(planTasks.map((t) => [t.id, t]));
    return new Set(shownRows.filter((id) => {
      const task = byId.get(id);
      return !!task && !task.is_summary && !contextRows.has(id) && (view !== 'calendar' || !!task.start);
    }));
  }, [gantt, planTasks, shownRows, contextRows, view]);
  useLayoutEffect(() => {
    if (drawn) selectRows((sel) => settleSelection(sel, (key) => drawn.has(key), () => null));
  }, [drawn, selectRows]);
  // the search box's Enter: the first match the view draws selected, the sheet focused
  const toFirstMatch = useCallback(() => {
    const first = shownRows.find((key) => !contextRows.has(key) && !bandRows.has(key) && (!drawn || drawn.has(key)));
    if (first) selectRows(selectCell(first, 'name'));
    focusSheet();
  }, [shownRows, contextRows, bandRows, drawn, selectRows, focusSheet]);
  // the Calendar's and the Board's pick: the sheet's selection (Ctrl or ⌘ adds to it)
  const pickTask = useCallback((id: string, additive: boolean) => {
    if (drawn && !drawn.has(id)) return;
    selectRows(additive ? (sel) => toggleRow(sel, id, 'name') : selectCell(id, 'name'));
  }, [drawn, selectRows]);
  const selectedIds = useMemo(() => new Set(commands.selected.map((t) => t.id)), [commands.selected]);
  const [strip, toggleStrip] = usePlanStrip(ctl.plan?.id ?? null);
  const [stripHeight, setStripHeight] = useState(0);

  const selectView = (next: PlanViewKey) => {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      if (next === 'gantt') p.delete('view'); else p.set('view', next);
      return p;
    }, { replace: true });
  };

  // a plan that goes away (deleted, out of reach) takes full screen with it
  useEffect(() => {
    if (!ready) setFullScreen(false);
  }, [ready]);

  useEffect(() => {
    if (!isFull) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !escapeTakenElsewhere(e)) setFullScreen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isFull]);

  let body;
  if (ctl.status === 'loading') {
    body = <p className="page-hint">Loading the project plan…</p>;
  } else if (ctl.status === 'error') {
    body = (
      <div className="init-panel pln-empty" role="alert">
        <p className="pf-error">{ctl.error}</p>
        <button type="button" className="mini-btn" onClick={() => void ctl.reload()}>Try again</button>
      </div>
    );
  } else if (ctl.status === 'none' || !ctl.plan) {
    body = (
      <PlanEmptyState canAdd={can('project_plans', 'add')}
                      onBlank={() => setDialog({ kind: 'create' })} />
    );
  } else {
    const plan = ctl.plan;
    const screenTip = COMMAND_TIPS[isFull ? 'exitFullScreen' : 'fullScreen'];
    const viewTip = PLAN_VIEWS.find((v) => v.key === view)?.tip ?? 'viewGantt';
    // grouped, the outline can't change: no new-task row
    const blankRow = canAddTasks(plan) && !sheet.grouped;
    body = (
      <>
        {plan.locked_at && <LockBanner ctl={ctl} plan={plan} />}

        {/* the toolbar slot */}
        <div className="pln-topbar">
          {/* the page header is covered in full screen: whose plan this is */}
          {isFull && <h2 className="pln-fs-name">{initiative.name}</h2>}
          <div className="pln-toolbar" role="toolbar" aria-label="Project plan" ref={toolbarRef}>
            {/* the view switcher: one compact menu button named by the view on
                ("Gantt ▾"), its items the views, the current one checked */}
            <div className="pln-tgroup pln-views" role="group" aria-label="View">
              <Tip label={COMMAND_TIPS[viewTip].label} desc={COMMAND_TIPS.view.desc}>
                <RowActionsMenu label={COMMAND_TIPS[viewTip].label} triggerClassName="mini-btn pln-tview" returnFocus
                                actions={PLAN_VIEWS.map((v) => ({
                                  key: v.key, label: COMMAND_TIPS[v.tip].label, hint: COMMAND_TIPS[v.tip].desc,
                                  checked: view === v.key, onSelect: () => selectView(v.key),
                                }))} />
              </Tip>
              <span className="pln-tgroup-label" aria-hidden="true">View</span>
            </div>
            <div className="pln-tools">
              <PlanToolbar plan={plan} ctl={ctl} commands={commands} layout={layout} onLayout={setLayout}
                           gantt={gantt} strip={strip} onStrip={toggleStrip} />
            </div>
            <Tip label={screenTip.label} desc={screenTip.desc}
                 keys={isFull ? tipKeys('exitFullScreen', detectPlatform()) : null}>
              {/* an icon, named by its tip's label: with the view switcher a
                  dropdown, the toolbar keeps to one line at 1512px, nav open */}
              <button type="button" className="mini-btn pln-screen-btn" aria-label={screenTip.label}
                      onClick={() => setFullScreen((on) => !on)}>
                <FullScreenIcon exit={isFull} />
              </button>
            </Tip>
          </div>
          {ctl.staleBy && <span className="pln-stale" role="status">{ctl.staleBy}</span>}
        </div>

        <PlanFilterBar view={sheet.view} onChange={sheet.setView} groupable={gantt} searchRef={searchRef}
                       counts={sheet.counts} onSearchEnter={toFirstMatch} onLeave={focusSheet} />

        {/* the view area */}
        <div className="pln-view" data-view={view} data-layout={layout} ref={viewRef}
             style={viewHeight === null ? undefined : { height: viewHeight }}>
          {/* the Timeline strip: the Gantt view's top band */}
          {gantt && strip && (
            <PlanTimelineStrip plan={plan} selected={selectedIds} onSelect={commands.goToTask}
                               onOpenInfo={openTaskInfoById} onHeight={setStripHeight} />
          )}
          {view === 'calendar' && (
            <PlanCalendar plan={plan} rows={sheet.rows} context={sheet.context} selected={selectedIds}
                          onSelect={pickTask} onOpenInfo={openTaskInfoById} />
          )}
          {view === 'board' && (
            <PlanBoard plan={plan} rows={sheet.rows} context={sheet.context} selected={selectedIds}
                       onSelect={pickTask} onOpenInfo={openTaskInfoById} completion={completion} />
          )}
          {gantt && (
            <GanttPanes layout={layout} on={ready} viewRef={viewRef} reserve={strip ? stripHeight : 0}
                        scrollRef={scrollRef} sheetSideRef={sheetSideRef}
                        sheet={(
                          <PlanSheet ctl={ctl} rows={sheet.rows} context={sheet.context} bands={sheet.bands}
                                     collapsed={sheet.collapsed} rowHeight={rowHeight}
                                     scrollRef={scrollRef} sideScrollRef={sheetSideRef} selection={sheet.selection}
                                     onSelect={sheet.select} onToggleCollapse={sheet.toggleCollapse}
                                     blankRow={blankRow} onOpenInfo={openTaskInfoById} grouped={sheet.grouped}
                                     cut={commands.cutMarks} onMoveTasks={commands.moveTasks} />
                        )}
                        chart={(slot) => (
                          <PlanGantt ctl={ctl} rows={sheet.rows} context={sheet.context} bands={sheet.bands}
                                     rowHeight={rowHeight} scrollRef={slot.scrollRef}
                                     zoom={commands.zoom} display={commands.display} selection={sheet.selection}
                                     onSelect={sheet.select} blankRow={blankRow} scheduled={scheduled}
                                     scrollRequest={commands.chartScroll} onZoomStep={zoomStep}
                                     focusSheet={commands.focusSheet} onLinkClick={openLink}
                                     onBarDoubleClick={openTaskInfo} taskLabels={slot.taskLabels}
                                     endPad={slot.endPad} startTop={slot.startTop}
                                     startMoment={slot.startMoment} onLeftMoment={slot.onLeftMoment} />
                        )} />
          )}
        </div>
      </>
    );
  }

  return (
    <div className={`pln-tab${isFull ? ' pln-fullscreen' : ''}`} ref={rootRef}>
      <CompletionContext.Provider value={completion}>
      {body}

      {/* the clipboard shortcuts' keystroke target (usePlanCommands): hidden but for that keystroke */}
      <textarea ref={clipRef} className="pln-clip" aria-label="Clipboard" tabIndex={-1} spellCheck={false} hidden />

      {/* the dialogs host */}
      {dialog?.kind === 'create' && (
        <PlanCreateModal ctl={ctl} initiative={initiative} onClose={closeDialog} />
      )}
      {dialog?.kind === 'columns' && <ColumnsModal onClose={closeDialog} />}
      {dialog?.kind === 'shortcuts' && <ShortcutsModal onClose={closeDialog} />}
      {dialog?.kind === 'deleteTasks' && (
        <DeleteTasksModal tasks={dialog.tasks} subtasks={dialog.subtasks} onClose={closeDialog}
                          onConfirm={() => commands.confirmDelete(dialog)} />
      )}
      {dialog?.kind === 'dependency' && <TaskDependencyModal ctl={ctl} linkId={dialog.linkId} onClose={closeDialog} />}
      {dialog?.kind === 'taskInfo' && (
        <TaskInfoModal key={dialog.taskId} ctl={ctl} taskId={dialog.taskId} tab={dialog.tab} onClose={closeDialog} />
      )}
      {dialog?.kind === 'replaceBaseline' && <ReplaceBaselineModal ctl={ctl} setAt={dialog.setAt} onClose={closeDialog} />}
      {dialog?.kind === 'clearBaseline' && <ClearBaselineModal ctl={ctl} onClose={closeDialog} />}
      {dialog?.kind === 'lock' && <LockModal ctl={ctl} onClose={closeDialog} />}
      {dialog?.kind === 'updateProject' && <UpdateProjectModal ctl={ctl} onClose={closeDialog} />}
      {dialog?.kind === 'settings' && <PlanSettingsModal ctl={ctl} onClose={closeDialog} />}
      {dialog?.kind === 'deletePlan' && (
        <DeletePlanModal ctl={ctl} initiativeName={initiative.name} onClose={closeDialog} />
      )}

      {/* the completion check, over any dialog it answers for */}
      {completion.dialog}
      </CompletionContext.Provider>
    </div>
  );
}

/** "Schedule locked by <name> on <date> — progress updates only", with
 *  Unlock for those who may change the plan. `locked_at` is an instant,
 *  so it reads in the browser's zone like every other timestamp. */
function LockBanner({ ctl, plan }: { ctl: PlanController; plan: Plan }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const who = plan.locked_by_name ? ` by ${plan.locked_by_name}` : '';

  const unlock = async () => {
    setBusy(true);
    try {
      await ctl.unlock();
    } catch (err) {
      if (!isPlanChanged(err)) toast(planErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pln-lock" role="status" aria-label="Schedule locked">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="5" y="11" width="14" height="10" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </svg>
      <span className="pln-lock-text">
        Schedule locked{who} on {longDate(plan.locked_at)} — progress updates only
      </span>
      {plan.permissions.change && (
        <Tip label={COMMAND_TIPS.unlock.label} desc={COMMAND_TIPS.unlock.desc}>
          <button type="button" className="mini-btn" disabled={busy} onClick={() => void unlock()}>
            {COMMAND_TIPS.unlock.label}
          </button>
        </Tip>
      )}
    </div>
  );
}

function FullScreenIcon({ exit }: { exit: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {exit
        ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
        : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
    </svg>
  );
}
