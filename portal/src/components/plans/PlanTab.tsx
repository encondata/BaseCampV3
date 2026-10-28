/**
 * The initiative's Project plan tab: the host every plan surface plugs
 * into. It owns the PlanController (usePlan), the URL state, full screen
 * and the open dialog, and lays out three slots:
 *
 *  - the toolbar slot: `.pln-toolbar` (role="toolbar", one tab stop, ←/→
 *    between its buttons) holds the view switcher at the left,
 *    PlanToolbar's groups in `.pln-tools` and Full screen at the right;
 *    beside it, outside the toolbar, the initiative's name in full screen
 *    and the "Plan updated by…" status. The commands, the MS Project
 *    keyboard map and the clipboard are usePlanCommands' and
 *    usePlanShortcuts';
 *  - the view area (`.pln-view`): the Gantt view — the task sheet, the
 *    splitter and the chart side by side (`.pln-split`) inside one
 *    vertical scroll box (`.pln-panes`, `scrollRef`) both panes virtualize
 *    against, each pane with its own sideways scroll (SidePane: the design
 *    is in Splitter.tsx). The splitter's place is the sheet pane's width,
 *    kept in localStorage `plans.split.v1`; Calendar and Board arrive in
 *    Plan C;
 *  - the dialogs host: one PlanModal-based dialog at a time (`PlanDialog`).
 *
 * The Gantt view's shared state lives here too (useSheetView.ts): the rows on
 * screen (the outline less collapsed subtasks; collapse state per plan in
 * localStorage `plans.collapsed.<planId>`), the selection, and the row
 * height (the list size).
 *
 * URL state lives beside `?tab=plan`: `&view=gantt|calendar|board` (Gantt
 * by default; only Gantt exists until Plan C, so anything else reads as
 * Gantt) and `&task=<id>` (reminder emails link to it): once the plan
 * loads, that task's collapsed summaries open, its row is selected and
 * scrolled into view; an id the plan doesn't have is ignored.
 *
 * Full screen fills the viewport above the portal chrome, which goes
 * inert meanwhile (Tab stays in the plan); Escape leaves it unless a
 * dialog or menu is open (Escape closes that first) or an editor has
 * focus (Escape cancels the edit).
 */

import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject,
} from 'react';
import { useSearchParams } from 'react-router-dom';

import { useAuth } from '../../auth/AuthContext';
import { longDate } from '../../lib/format';
import { listScale } from '../../lib/listTools';
import { useToast } from '../../lib/notificationsContext';
import type { Plan } from '../../lib/plans/api';
import { SHEET_ROW_PX } from '../../lib/plans/columns';
import { canAddTasks } from '../../lib/plans/editOps';
import { isPlanChanged, planErrorText } from '../../lib/plans/errors';
import { MIN_SHEET_PX, maxSplit, readSplit, splitWidth, writeSplit } from '../../lib/plans/ganttView';
import ColumnsModal from './ColumnsModal';
import DeleteTasksModal from './DeleteTasksModal';
import PlanCreateModal, { type PlanInitiative } from './PlanCreateModal';
import PlanEmptyState from './PlanEmptyState';
import PlanGantt from './PlanGantt';
import PlanSheet from './PlanSheet';
import PlanToolbar, { useRovingToolbar } from './PlanToolbar';
import ShortcutsModal from './ShortcutsModal';
import Splitter, { SidePane } from './Splitter';
import { usePlan, type PlanController } from './usePlan';
import { usePlanCommands, type PlanDialog } from './usePlanCommands';
import { usePlanShortcuts } from './usePlanShortcuts';
import { useSheetView } from './useSheetView';

import '../../styles/plans.css';

export type PlanViewKey = 'gantt' | 'calendar' | 'board';

/** The views the switcher offers. Plan C adds Calendar and Board. */
const PLAN_VIEWS: readonly { key: PlanViewKey; label: string }[] = [
  { key: 'gantt', label: 'Gantt' },
];

/** `?view=` as one of the views on offer; anything else is the Gantt. */
function readView(param: string | null): PlanViewKey {
  return PLAN_VIEWS.find((v) => v.key === param)?.key ?? 'gantt';
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

/** The splitter's place: the sheet pane's width in px, within what the view
 *  (`ref`, the scroll box, measured while `on`) leaves the chart. `move`
 *  follows a drag; `save` keeps the place (`plans.split.v1`). */
function useSplit(ref: RefObject<HTMLElement | null>, on: boolean) {
  const [viewW, setViewW] = useState(0);
  const [stored, setStored] = useState<number | null>(readSplit);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!on || !el) return undefined;
    const measure = () => setViewW(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, on]);
  const width = splitWidth(stored, viewW);
  const save = useCallback((px: number) => {
    setStored(px);
    writeSplit(px);
  }, []);
  return { width, max: viewW > 0 ? maxSplit(viewW) : Math.max(width, MIN_SHEET_PX), move: setStored, save };
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
  const { can, preferences } = useAuth();
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
  const rowHeight = Math.round(SHEET_ROW_PX * listScale(preferences?.list_size));
  const sheet = useSheetView(ctl, searchParams.get('task'), scrollRef, rowHeight);
  const commands = usePlanCommands({ ctl, sheet, root: rootRef, clip: clipRef, openDialog: setDialog });
  usePlanShortcuts(commands.handlers, { root: rootRef, enabled: ready && view === 'gantt' });
  useRovingToolbar(toolbarRef, ready);
  const split = useSplit(scrollRef, ready && view === 'gantt');
  const { scheduled_start: scheduledStart, scheduled_end: scheduledEnd } = initiative;
  const scheduled = useMemo(() => ({ start: scheduledStart, end: scheduledEnd }), [scheduledStart, scheduledEnd]);
  const { zoomIn, zoomOut } = commands;
  const zoomStep = useCallback((dir: -1 | 1) => (dir < 0 ? zoomIn() : zoomOut()), [zoomIn, zoomOut]);

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
    body = (
      <>
        {plan.locked_at && <LockBanner ctl={ctl} plan={plan} />}

        {/* the toolbar slot */}
        <div className="pln-topbar">
          {/* the page header is covered in full screen: whose plan this is */}
          {isFull && <h2 className="pln-fs-name">{initiative.name}</h2>}
          <div className="pln-toolbar" role="toolbar" aria-label="Project plan" ref={toolbarRef}>
            <div className="pln-tgroup">
              <div className="segmented pln-views" role="group" aria-label="View">
                {PLAN_VIEWS.map((v) => (
                  <button key={v.key} type="button" aria-pressed={view === v.key}
                          className={view === v.key ? 'on' : ''} onClick={() => selectView(v.key)}>
                    {v.label}
                  </button>
                ))}
              </div>
              <span className="pln-tgroup-label" aria-hidden="true">View</span>
            </div>
            <div className="pln-tools">
              <PlanToolbar plan={plan} ctl={ctl} commands={commands} />
            </div>
            <button type="button" className="mini-btn pln-screen-btn"
                    title={isFull ? 'Exit full screen (Esc)' : undefined}
                    onClick={() => setFullScreen((on) => !on)}>
              <FullScreenIcon exit={isFull} />
              {isFull ? 'Exit full screen' : 'Full screen'}
            </button>
          </div>
          {ctl.staleBy && <span className="pln-stale" role="status">{ctl.staleBy}</span>}
        </div>

        {/* the view area */}
        <div className="pln-view" data-view={view} ref={viewRef}
             style={viewHeight === null ? undefined : { height: viewHeight }}>
          {view === 'gantt' && (
            <div className="pln-panes" ref={scrollRef}>
              <div className="pln-split" style={{ '--pln-split': `${split.width}px` } as CSSProperties}>
                <SidePane className="pln-pane-sheet" barRef={sheetSideRef}>
                  <PlanSheet ctl={ctl} rows={sheet.rows} collapsed={sheet.collapsed} rowHeight={rowHeight}
                             scrollRef={scrollRef} sideScrollRef={sheetSideRef} selection={sheet.selection}
                             onSelect={sheet.select} onToggleCollapse={sheet.toggleCollapse}
                             blankRow={canAddTasks(plan)} />
                </SidePane>
                <Splitter value={split.width} min={MIN_SHEET_PX} max={split.max} label="Resize the task sheet"
                          onChange={split.move} onCommit={split.save} />
                <PlanGantt ctl={ctl} rows={sheet.rows} rowHeight={rowHeight} scrollRef={scrollRef}
                           zoom={commands.zoom} display={commands.display} selection={sheet.selection}
                           onSelect={sheet.select} editable={plan.permissions.change && !plan.locked_at}
                           blankRow={canAddTasks(plan)} scheduled={scheduled} scrollRequest={commands.chartScroll}
                           onZoomStep={zoomStep} focusSheet={commands.focusSheet} />
              </div>
            </div>
          )}
        </div>
      </>
    );
  }

  return (
    <div className={`pln-tab${isFull ? ' pln-fullscreen' : ''}`} ref={rootRef}>
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
      {/* Task 10 renders taskInfo, setBaseline, clearBaseline, updateProject, settings and deletePlan */}
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
        <button type="button" className="mini-btn" disabled={busy} onClick={() => void unlock()}>
          Unlock
        </button>
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
