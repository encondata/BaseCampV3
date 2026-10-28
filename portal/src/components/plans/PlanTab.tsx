/**
 * The initiative's Project plan tab: the host every plan surface plugs
 * into. It owns the PlanController (usePlan), the URL state, full screen
 * and the open dialog, and lays out three slots:
 *
 *  - the toolbar slot (`.pln-toolbar`): the view switcher at the left,
 *    PlanToolbar's groups in `.pln-tools` (Task 7), Full screen at the right;
 *  - the view area (`.pln-view`): the Gantt view (sheet + chart, Tasks 5
 *    and 8) inside one scroll box (`.pln-panes`, `scrollRef`) both panes
 *    virtualize against; Calendar and Board arrive in Plan C;
 *  - the dialogs host: one PlanModal-based dialog at a time (`PlanDialog`).
 *
 * The Gantt view's shared state lives here too (useSheetView): the rows on
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
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject,
} from 'react';
import { useSearchParams } from 'react-router-dom';

import { useAuth } from '../../auth/AuthContext';
import { longDate } from '../../lib/format';
import { listScale } from '../../lib/listTools';
import { useToast } from '../../lib/notificationsContext';
import type { Plan, PlanTask } from '../../lib/plans/api';
import { SHEET_HEAD_PX, SHEET_ROW_PX } from '../../lib/plans/columns';
import { isPlanChanged, planErrorText } from '../../lib/plans/errors';
import { ancestors, visibleRows } from '../../lib/plans/outline';
import { EMPTY_SELECTION, selectCell, type Selection } from '../../lib/plans/selection';
import ColumnsModal from './ColumnsModal';
import PlanCreateModal, { type PlanInitiative } from './PlanCreateModal';
import PlanEmptyState from './PlanEmptyState';
import PlanSheet from './PlanSheet';
import { usePlan, type PlanController } from './usePlan';

import '../../styles/plans.css';

export type PlanViewKey = 'gantt' | 'calendar' | 'board';

/** The views the switcher offers. Plan C adds Calendar and Board. */
const PLAN_VIEWS: readonly { key: PlanViewKey; label: string }[] = [
  { key: 'gantt', label: 'Gantt' },
];

/** The dialog the tab has open; later tasks add their kinds here. */
type PlanDialog = { kind: 'create' } | { kind: 'columns' };

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

/** What stays live behind full screen: the toasts, whose actions (Undo,
 *  Open) still have to be reachable. */
const KEEP_LIVE = '.toast-host';

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

const COLLAPSED_PREFIX = 'plans.collapsed.';
const NO_TASKS: PlanTask[] = [];

/** The summaries collapsed in this browser for the plan. */
function readCollapsed(planId: string): Set<string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(COLLAPSED_PREFIX + planId) ?? '[]');
    return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeCollapsed(planId: string, ids: Iterable<string>): void {
  try {
    localStorage.setItem(COLLAPSED_PREFIX + planId, JSON.stringify([...ids]));
  } catch {
    // storage refused: the choice lasts this visit only
  }
}

/**
 * The Gantt view's shared state: the rows the sheet and the chart show,
 * which summaries are collapsed, the selection, and the `&task=` deep
 * link (handled once per plan and task id).
 */
function useSheetView(ctl: PlanController, taskParam: string | null,
  scrollRef: RefObject<HTMLDivElement | null>, rowHeight: number) {
  const plan = ctl.plan;
  const planId = plan?.id ?? null;
  const tasks = plan?.tasks ?? NO_TASKS;
  const tasksById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const order = useMemo(() => tasks.map((t) => t.id), [tasks]);

  const stored = useMemo(() => (planId ? readCollapsed(planId) : new Set<string>()), [planId]);
  const [changed, setChanged] = useState<{ planId: string; ids: Set<string> } | null>(null);
  const collapsed = changed && changed.planId === planId ? changed.ids : stored;
  const setCollapsed = useCallback((ids: Set<string>) => {
    if (!planId) return;
    setChanged({ planId, ids });
    writeCollapsed(planId, [...ids].filter((id) => tasksById.has(id)));
  }, [planId, tasksById]);

  const rows = useMemo(() => visibleRows(order, tasksById, collapsed), [order, tasksById, collapsed]);

  // another plan (another initiative) starts with nothing selected
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [selectionPlan, setSelectionPlan] = useState(planId);
  if (selectionPlan !== planId) {
    setSelectionPlan(planId);
    setSelection(EMPTY_SELECTION);
  }

  const toggleCollapse = useCallback((id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
      // the active cell's row going out of sight: the summary takes it (MS Project)
      setSelection((sel) => (sel.active && sel.active.id !== 'blank'
        && ancestors(sel.active.id, tasksById).includes(id) ? selectCell(id, sel.active.col) : sel));
    }
    setCollapsed(next);
  }, [collapsed, setCollapsed, tasksById]);

  const linked = useRef<string | null>(null);
  const [scrollTo, setScrollTo] = useState<string | null>(null);
  useEffect(() => {
    if (!planId || !taskParam) return;
    const key = `${planId}:${taskParam}`;
    if (linked.current === key) return;
    linked.current = key;
    if (!tasksById.has(taskParam)) return;
    const closed = ancestors(taskParam, tasksById).filter((id) => collapsed.has(id));
    if (closed.length) setCollapsed(new Set([...collapsed].filter((id) => !closed.includes(id))));
    setSelection(selectCell(taskParam, 'name'));
    setScrollTo(taskParam);
  }, [planId, taskParam, tasksById, collapsed, setCollapsed]);

  // runs once the rows include the task, so the scroll box is tall enough
  useEffect(() => {
    if (!scrollTo) return;
    const index = rows.indexOf(scrollTo);
    const box = scrollRef.current;
    if (index < 0 || !box) return;
    const below = Math.max(0, box.clientHeight - SHEET_HEAD_PX - rowHeight);
    box.scrollTop = Math.max(0, index * rowHeight - below / 2);
    setScrollTo(null);
  }, [scrollTo, rows, rowHeight, scrollRef]);

  return { rows, collapsed, toggleCollapse, selection, select: setSelection };
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
  const rowHeight = Math.round(SHEET_ROW_PX * listScale(preferences?.list_size));
  const sheet = useSheetView(ctl, searchParams.get('task'), scrollRef, rowHeight);

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
        <div className="pln-toolbar" role="toolbar" aria-label="Project plan">
          {/* the page header is covered in full screen: whose plan this is */}
          {isFull && <h2 className="pln-fs-name">{initiative.name}</h2>}
          <div className="segmented" role="group" aria-label="View">
            {PLAN_VIEWS.map((v) => (
              <button key={v.key} type="button" aria-pressed={view === v.key}
                      className={view === v.key ? 'on' : ''} onClick={() => selectView(v.key)}>
                {v.label}
              </button>
            ))}
          </div>
          <div className="pln-tools">
            {/* PlanToolbar (Task 7); Columns… moves into its More menu */}
            <button type="button" className="mini-btn" onClick={() => setDialog({ kind: 'columns' })}>
              Columns…
            </button>
          </div>
          {ctl.staleBy && <span className="pln-stale" role="status">{ctl.staleBy}</span>}
          <button type="button" className="mini-btn pln-screen-btn"
                  title={isFull ? 'Exit full screen (Esc)' : undefined}
                  onClick={() => setFullScreen((on) => !on)}>
            <FullScreenIcon exit={isFull} />
            {isFull ? 'Exit full screen' : 'Full screen'}
          </button>
        </div>

        {/* the view area */}
        <div className="pln-view" data-view={view} ref={viewRef}
             style={viewHeight === null ? undefined : { height: viewHeight }}>
          {view === 'gantt' && (
            <div className="pln-panes" ref={scrollRef}>
              <PlanSheet ctl={ctl} rows={sheet.rows} collapsed={sheet.collapsed} rowHeight={rowHeight}
                         scrollRef={scrollRef} selection={sheet.selection} onSelect={sheet.select}
                         onToggleCollapse={sheet.toggleCollapse} editable={plan.permissions.change} />
            </div>
          )}
        </div>
      </>
    );
  }

  return (
    <div className={`pln-tab${isFull ? ' pln-fullscreen' : ''}`} ref={rootRef}>
      {body}

      {/* the dialogs host */}
      {dialog?.kind === 'create' && (
        <PlanCreateModal ctl={ctl} initiative={initiative} onClose={closeDialog} />
      )}
      {dialog?.kind === 'columns' && <ColumnsModal onClose={closeDialog} />}
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
