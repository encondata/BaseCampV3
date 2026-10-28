/**
 * The plan's toolbar ("ribbon-lite"): MS Project's Task ribbon groups, in
 * order, each a labeled cluster of icon buttons:
 *
 *   Undo · Schedule (0–100%, Mark on Track, Link, Unlink, Indent, Outdent)
 *   · Tasks (Auto / Manual, a `.segmented` pair showing the selection's
 *   mode) · Insert (Task, Summary, Milestone) · Properties (Information,
 *   Notes, Add to Timeline) · Display (Critical path, Baseline, Zoom − / +
 *   / Fit, Scroll to task; the Timeline strip comes in Plan C) · Gantt (the
 *   layout: Beside, Below or Hidden, a `.segmented` trio) · More.
 *
 * Every button has a hover tip (components/Tip) in place of a native title:
 * its name (the button's accessible name), its shortcut as keycaps
 * (lib/plans/shortcuts, so it never disagrees with the key), what it does
 * and, when it's off, why. The names, sentences and reasons are one table,
 * lib/plans/commandTips.
 *
 * Read-only people see Display, Gantt and More (Columns…, Keyboard
 * shortcuts) only. On a locked plan the buttons that change the schedule
 * stay reachable but off, their tip saying "Schedule is locked"; progress
 * (0–100%, Mark on Track, Notes) still works. A button that needs a
 * selection says so instead; with the chart Hidden, the chart-only commands
 * (Critical Path, Baseline, Zoom, Fit, Scroll to Task) say to show it. Off
 * buttons are `aria-disabled`, not `disabled`, so they keep their tip and
 * their place in the arrow-key order (the ARIA toolbar pattern).
 *
 * `useRovingToolbar` gives the toolbar element (PlanTab's, which also
 * holds the view switcher and Full screen) one tab stop: ←/→ move between
 * its buttons, Home/End go to the ends. A mouse click on a command hands
 * focus back to the sheet, as MS Project does; a key press on one keeps
 * it on the button.
 */
import { useEffect, useLayoutEffect, useRef, type MouseEvent, type ReactNode, type RefObject } from 'react';

import type { Plan } from '../../lib/plans/api';
import {
  COMMAND_TIPS, OFF_NOTES, redoDesc, tipKeys, undoDesc, type CommandTipId,
} from '../../lib/plans/commandTips';
import { canAddTasks } from '../../lib/plans/editOps';
import { ZOOMS } from '../../lib/plans/ganttGeometry';
import type { GanttLayout } from '../../lib/plans/ganttView';
import { detectPlatform, type Platform } from '../../lib/plans/shortcuts';
import { RowActionsMenu, type RowAction } from '../hardware/RowActionsMenu';
import Tip from '../Tip';
import type { PlanCommands } from './usePlanCommands';
import type { PlanController } from './usePlan';

export const LOCKED_HINT = OFF_NOTES.locked;
export const NO_BASELINE_HINT = OFF_NOTES.noBaseline;
const SELECT_HINT = OFF_NOTES.select;
const SELECT_TWO_HINT = OFF_NOTES.selectTwo;
const PERCENTS = [
  [0, 'pct0'], [25, 'pct25'], [50, 'pct50'], [75, 'pct75'], [100, 'pct100'],
] as const;
/** The layout trio, in order, with its tips. */
const LAYOUTS: readonly (readonly [GanttLayout, CommandTipId])[] = [
  ['beside', 'layoutBeside'], ['below', 'layoutBelow'], ['hidden', 'layoutHidden'],
];

interface Props {
  plan: Plan;
  ctl: Pick<PlanController, 'canUndo' | 'canRedo' | 'undoLabel' | 'redoLabel'>;
  commands: PlanCommands;
  platform?: Platform;
  /** Where the Gantt chart is (PlanTab keeps it). */
  layout: GanttLayout;
  onLayout(layout: GanttLayout): void;
}

export default function PlanToolbar({ plan, ctl, commands: cmd, platform, layout, onLayout }: Props) {
  const os = platform ?? detectPlatform();
  const canChange = plan.permissions.change;
  const locked = plan.locked_at !== null;
  const count = cmd.selected.length;
  /** Why a schedule change is off now, or null. */
  const structure = (need: 1 | 2 = 1) => (locked ? LOCKED_HINT
    : count < need ? (need === 2 ? SELECT_TWO_HINT : SELECT_HINT) : null);
  const progress = count ? null : SELECT_HINT;
  const zoomAt = ZOOMS.indexOf(cmd.zoom);
  /** The chart-only commands are off while the chart is hidden. */
  const noChart = layout === 'hidden' ? OFF_NOTES.noChart : null;

  const more: RowAction[] = [];
  if (canChange) {
    const noBaseline = plan.baseline_set_at === null;
    more.push(
      { key: 'baseline', label: 'Set baseline…', onSelect: cmd.setBaseline, disabled: locked,
        hint: locked ? LOCKED_HINT : undefined },
      { key: 'clear-baseline', label: 'Clear baseline…', onSelect: () => cmd.open('clearBaseline'),
        disabled: locked || noBaseline, hint: locked ? LOCKED_HINT : noBaseline ? NO_BASELINE_HINT : undefined },
      { key: 'update', label: 'Update project…', onSelect: () => cmd.open('updateProject') },
      locked
        ? { key: 'unlock', label: 'Unlock schedule', onSelect: cmd.unlock }
        : { key: 'lock', label: 'Lock schedule…', onSelect: cmd.lock },
      { key: 'settings', label: 'Plan settings…', onSelect: () => cmd.open('settings') },
    );
  }
  more.push(
    { key: 'columns', label: 'Columns…', onSelect: () => cmd.open('columns') },
    { key: 'shortcuts', label: 'Keyboard shortcuts', onSelect: () => cmd.open('shortcuts') },
  );
  if (plan.permissions.delete) {
    more.push({ key: 'delete-plan', label: 'Delete plan…', onSelect: () => cmd.open('deletePlan'), destructive: true });
  }

  const tool = (id: CommandTipId, run: () => void, icon: ReactNode, o: {
    hint?: string | null; pressed?: boolean; desc?: string;
  } = {}) => (
    <Tool key={id} label={COMMAND_TIPS[id].label} desc={o.desc ?? COMMAND_TIPS[id].desc} keys={tipKeys(id, os)}
          hint={o.hint ?? null} pressed={o.pressed} onRun={run} focusSheet={cmd.focusSheet}>{icon}</Tool>
  );
  const moreTip = COMMAND_TIPS[canChange ? 'more' : 'moreReadOnly'];

  return (
    <>
      {canChange && (
        <Group label="Undo">
          {tool('undo', cmd.undo, <Icon name="undo" />, {
            hint: ctl.canUndo ? null : OFF_NOTES.noUndo, desc: undoDesc(ctl.undoLabel),
          })}
          {tool('redo', cmd.redo, <Icon name="redo" />, {
            hint: ctl.canRedo ? null : OFF_NOTES.noRedo, desc: redoDesc(ctl.redoLabel),
          })}
        </Group>
      )}

      {canChange && (
        <Group label="Schedule">
          {PERCENTS.map(([n, id]) => tool(id, () => cmd.percent(n), <Pie percent={n} />, { hint: progress }))}
          {tool('markOnTrack', cmd.markOnTrack, <Icon name="track" />, { hint: progress })}
          <span className="pln-tsep" aria-hidden="true" />
          {tool('link', cmd.link, <Icon name="link" />, { hint: structure(2) })}
          {tool('unlink', cmd.unlink, <Icon name="unlink" />, { hint: structure() })}
          <span className="pln-tsep" aria-hidden="true" />
          {tool('outdent', cmd.outdent, <Icon name="outdent" />, { hint: structure() })}
          {tool('indent', cmd.indent, <Icon name="indent" />, { hint: structure() })}
        </Group>
      )}

      {canChange && (
        <Group label="Tasks" bare>
          <div className="segmented pln-modes">
            {(['auto', 'manual'] as const).map((m) => {
              const tip = COMMAND_TIPS[m];
              const hint = structure();
              return (
                <Tip key={m} label={tip.label} desc={tip.desc} note={hint}>
                  {/* the visible "Auto" / "Manual" begins the name MS Project gives the command */}
                  <button type="button" className={cmd.mode === m ? 'on' : ''} aria-pressed={cmd.mode === m}
                          aria-label={tip.label} aria-disabled={hint ? true : undefined}
                          onClick={(e) => {
                            if (hint) return;
                            cmd.setMode(m);
                            if (e.detail > 0) cmd.focusSheet();
                          }}>
                    {m === 'auto' ? 'Auto' : 'Manual'}
                  </button>
                </Tip>
              );
            })}
          </div>
        </Group>
      )}

      {canChange && plan.permissions.add && (
        <Group label="Insert">
          {tool('insertTask', () => cmd.insert('task'), <Icon name="task" />, {
            hint: canAddTasks(plan) ? null : LOCKED_HINT,
          })}
          {tool('insertSummary', () => cmd.insert('summary'), <Icon name="summary" />, {
            hint: canAddTasks(plan) ? null : LOCKED_HINT,
          })}
          {tool('insertMilestone', () => cmd.insert('milestone'), <Icon name="milestone" />, {
            hint: canAddTasks(plan) ? null : LOCKED_HINT,
          })}
        </Group>
      )}

      {canChange && (
        <Group label="Properties">
          {tool('info', () => cmd.info(), <Icon name="info" />, { hint: progress })}
          {tool('notes', () => cmd.info('notes'), <Icon name="notes" />, { hint: progress })}
          {tool('timeline', cmd.timeline, <Icon name="timeline" />, { hint: structure(), pressed: cmd.onTimeline })}
        </Group>
      )}

      <Group label="Display">
        {tool('critical', cmd.toggleCritical, <Icon name="critical" />, { hint: noChart, pressed: cmd.display.critical })}
        {tool('baseline', cmd.toggleBaseline, <Icon name="baseline" />, { hint: noChart, pressed: cmd.display.baseline })}
        <span className="pln-tsep" aria-hidden="true" />
        {tool('zoomOut', cmd.zoomOut, <Icon name="zoomOut" />, {
          hint: noChart ?? (zoomAt === ZOOMS.length - 1 ? OFF_NOTES.zoomedOut : null),
        })}
        {tool('zoomIn', cmd.zoomIn, <Icon name="zoomIn" />, {
          hint: noChart ?? (zoomAt === 0 ? OFF_NOTES.zoomedIn : null),
        })}
        {tool('fit', cmd.fit, <Icon name="fit" />, { hint: noChart })}
        <span className="pln-tsep" aria-hidden="true" />
        {tool('scrollToTask', cmd.scrollToTask, <Icon name="scroll" />, {
          hint: noChart ?? (count ? null : SELECT_HINT),
        })}
      </Group>

      {/* where the chart goes: about the monitor, so everyone has it. Like the
          view switcher it leaves focus where it is: focusing a sheet with
          nothing selected would select its first row and scroll up to it */}
      <Group label="Gantt" bare>
        <div className="segmented pln-layouts">
          {LAYOUTS.map(([value, id]) => {
            const tip = COMMAND_TIPS[id];
            return (
              <Tip key={value} label={tip.label} desc={tip.desc}>
                <button type="button" className={layout === value ? 'on' : ''} aria-pressed={layout === value}
                        onClick={() => onLayout(value)}>
                  {tip.label}
                </button>
              </Tip>
            );
          })}
        </div>
      </Group>

      <div className="pln-tmore">
        {/* the trigger's ▾ marks its menu; the tip names the command */}
        <Tip label={moreTip.label} desc={moreTip.desc}>
          <RowActionsMenu label="More" actions={more} />
        </Tip>
      </div>
    </>
  );
}

function Group({ label, bare = false, children }: { label: string; bare?: boolean; children: ReactNode }) {
  return (
    <div className="pln-tgroup" role="group" aria-label={label}>
      {bare ? children : <div className="pln-tgroup-btns">{children}</div>}
      <span className="pln-tgroup-label" aria-hidden="true">{label}</span>
    </div>
  );
}

/** An icon button with its tip: the name (also its accessible name), the
 *  keys, what it does and, when off (`hint`), why. */
function Tool({ label, desc, keys, hint, pressed, onRun, focusSheet, children }: {
  label: string; desc: string; keys: string; hint: string | null; pressed?: boolean;
  onRun(): void; focusSheet(): void; children: ReactNode;
}) {
  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (hint) return;
    onRun();
    // a click hands focus back to the sheet; Enter or Space on the button keeps it here
    if (e.detail > 0) focusSheet();
  };
  return (
    <Tip label={label} keys={keys} desc={desc} note={hint}>
      <button type="button" className={`mini-btn pln-tbtn${pressed ? ' on' : ''}`} aria-label={label}
              aria-disabled={hint ? true : undefined} aria-pressed={pressed} onClick={onClick}>
        {children}
      </button>
    </Tip>
  );
}

/** The toolbar element's buttons, in order: the arrow keys' stops. */
function stops(bar: HTMLElement): HTMLElement[] {
  return [...bar.querySelectorAll<HTMLElement>('button')].filter((b) => !(b as HTMLButtonElement).disabled);
}

/**
 * One tab stop for `ref`'s toolbar (role="toolbar"): the button last
 * focused there (the first at the start) is the stop; ←/→ move between the
 * buttons, wrapping, and Home/End go to the ends. Keys with a modifier,
 * and keys an open menu or the view switcher's own widgets took, pass.
 */
export function useRovingToolbar(ref: RefObject<HTMLElement | null>, active = true): void {
  const current = useRef<HTMLElement | null>(null);

  // after every render: the buttons may have changed (a group shown, the More menu's trigger)
  useLayoutEffect(() => {
    const bar = ref.current;
    if (!bar) return;
    const items = stops(bar);
    if (!current.current || !items.includes(current.current)) current.current = items[0] ?? null;
    for (const el of items) el.tabIndex = el === current.current ? 0 : -1;
  });

  useEffect(() => {
    const bar = ref.current;
    if (!bar) return undefined;
    const take = (el: HTMLElement) => {
      current.current = el;
      for (const item of stops(bar)) item.tabIndex = item === el ? 0 : -1;
    };
    const onFocus = (e: FocusEvent) => {
      const items = stops(bar);
      const el = e.target as HTMLElement;
      if (items.includes(el)) take(el);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      const items = stops(bar);
      const at = items.indexOf(e.target as HTMLElement);
      if (at < 0 || !items.length) return;
      const n = items.length;
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1
        : e.key === 'ArrowLeft' ? (at - 1 + n) % n : (at + 1) % n;
      e.preventDefault();
      take(items[next]);
      items[next].focus();
    };
    bar.addEventListener('focusin', onFocus);
    bar.addEventListener('keydown', onKey);
    return () => {
      bar.removeEventListener('focusin', onFocus);
      bar.removeEventListener('keydown', onKey);
    };
    // `active`: the toolbar element comes and goes with the plan
  }, [ref, active]);
}

// ── icons ──

function Pie({ percent }: { percent: number }) {
  const wedge: Record<number, string> = {
    25: 'M12 12V4a8 8 0 0 1 8 8z',
    50: 'M12 12V4a8 8 0 0 1 0 16z',
    75: 'M12 12V4a8 8 0 1 1-8 8z',
  };
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8" fill={percent === 100 ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" />
      {wedge[percent] && <path d={wedge[percent]} fill="currentColor" />}
    </svg>
  );
}

const ICONS: Record<string, ReactNode> = {
  undo: <><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></>,
  redo: <><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></>,
  track: <><rect x="3" y="10" width="11" height="6" rx="1.5" /><path d="m15.5 9 2.5 2.5L22 6.5" /></>,
  link: <><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" /><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" /></>,
  unlink: <><path d="m18.84 12.25 1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="m5.17 11.75-1.71 1.71a5 5 0 0 0 7.07 7.07l1.71-1.71" /><path d="M8 2v3M2 8h3M16 22v-3M22 16h-3" /></>,
  indent: <><path d="M3 5h18M11 10h10M11 14h10M3 19h18" /><path d="m3 9 4 3-4 3" /></>,
  outdent: <><path d="M3 5h18M11 10h10M11 14h10M3 19h18" /><path d="m7 9-4 3 4 3" /></>,
  task: <><path d="M3 6h11M3 11h11M3 16h7" /><path d="M18 13v7M14.5 16.5h7" /></>,
  summary: <><path d="M3 5h16v3.5l-2 2-2-2H7l-2 2-2-2z" /><path d="M7 15h9M7 19h6" /></>,
  milestone: <path d="M12 3.5 20.5 12 12 20.5 3.5 12z" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.2" /></>,
  notes: <><path d="M6 3h8.5L19 7.5V21H6z" /><path d="M9 11.5h7M9 15.5h7" /></>,
  timeline: <><rect x="3" y="9" width="18" height="6" rx="3" /><path d="M9 4v5M15 15v5" /></>,
  critical: <><rect x="3" y="5" width="8" height="5" rx="1.2" /><rect x="13" y="14" width="8" height="5" rx="1.2" /><path d="M11 7.5h3.5v6.5" /></>,
  baseline: <><rect x="3" y="5" width="14" height="6" rx="1.2" /><rect x="7" y="15" width="14" height="4" rx="1" /></>,
  zoomOut: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5M8 11h6" /></>,
  zoomIn: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5M8 11h6M11 8v6" /></>,
  fit: <><path d="M3 5v14M21 5v14" /><path d="M7 12h10" /><path d="m9.5 9-3 3 3 3M14.5 9l3 3-3 3" /></>,
  scroll: <><rect x="11" y="9" width="10" height="6" rx="1.5" /><path d="M3 12h5" /><path d="m6 9 3 3-3 3" /></>,
};

function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
         strokeLinejoin="round" aria-hidden="true">{ICONS[name]}</svg>
  );
}
