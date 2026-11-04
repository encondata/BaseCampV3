/**
 * GenerateReportModal's options step for `report_type === 'project_plan'`:
 * the plan as a PDF, the task table and then the Gantt chart on pages of
 * its own (api reports/project_plan). Opened from the plan's More › Export
 * ▸ PDF… (the plan in hand, its view's columns, zoom and Display toggles
 * as the starting choices) or from the Reports page after the pick step
 * (the plan fetched here; an initiative without one says so).
 *
 * Every task prints (or every unfinished one): the sheet's filter and Group
 * by don't apply. The preview card's page estimate is lib/plans/planPdf's,
 * the same page geometry the worker lays the PDF out with, so a very long
 * PDF shows before Generate (there is no size cap; the worker's timeout is
 * the guard). Run options: {columns, zoom, paper, include_completed,
 * show_critical, show_baseline}, plus {from, to} for a custom range.
 */
import { useEffect, useMemo, useState } from 'react';

import { ApiError, type ReportDefinition } from '../../lib/api';
import { getPlan, type Plan } from '../../lib/plans/api';
import { DEFAULT_VISIBLE, PLAN_COLUMNS, REQUIRED_COLUMNS, columnPrefsSnapshot } from '../../lib/plans/columns';
import { dayOf, formatDay, fromMs, lastDay, toMs } from '../../lib/plans/floatingTime';
import { MS_PER_DAY, type Zoom } from '../../lib/plans/ganttGeometry';
import {
  RANGE_OUTSIDE, RANGE_TOO_LONG, estimatePages, estimateText, planSpan, printRange, spanTooLong, type Paper,
} from '../../lib/plans/planPdf';
import { RUN_ERROR_TEXT } from '../../lib/reports';
import ChipPicker from '../ChipPicker';
import { Switch } from '../Switch';
import { OptionGroup, OptionsGrid, PreviewCard } from './ReportOptionsLayout';
import '../../styles/profile.css';   /* .pf-form, .pf-error */
import '../../styles/reports.css';   /* the options grid and groups */

/** What the PDF offers: Fit, or days and coarser (Fit may still draw hours). */
type Timescale = 'fit' | 'days' | 'weeks' | 'months' | 'quarters';
type ColumnsMode = 'current' | 'default' | 'choose';
type RangeMode = 'whole' | 'custom';

/** The starting choices: the plan's view (More › Export ▸ PDF…). */
export interface ProjectPlanInitial {
  /** The sheet's visible column keys, in order (Current view). */
  columns?: readonly string[];
  zoom?: Zoom;
  critical?: boolean;
  baseline?: boolean;
}

const TIMESCALES: readonly (readonly [Timescale, string])[] = [
  ['fit', 'Fit'], ['days', 'Days'], ['weeks', 'Weeks'], ['months', 'Months'], ['quarters', 'Quarters'],
];
/** How "Fit draws it by …" names the zoom Fit chose (PRINT_ZOOMS: hours and coarser). */
const ZOOM_WORDS: Record<Zoom, string> = {
  fiveMinutes: 'five minutes', quarterHours: 'quarter hours', wideHours: 'hours',
  hours: 'hours', days: 'days', weeks: 'weeks', months: 'months', quarters: 'quarters',
};
/** The screen's zoom as the PDF's starting timescale: Fit unless the PDF offers it. */
const startingTimescale = (zoom: Zoom | undefined): Timescale =>
  TIMESCALES.find(([value]) => value === zoom)?.[0] ?? 'fit';
/** The columns Choose… offers: all but ID and Task Name (always printed) and the sheet's icons. */
const PICKABLE = PLAN_COLUMNS.filter((c) => !REQUIRED_COLUMNS.has(c.key) && c.key !== 'indicators')
  .map((c) => ({ value: c.key, label: c.label }));
const PICKABLE_KEYS = new Set(PICKABLE.map((c) => c.value));

const NO_PLAN = RUN_ERROR_TEXT.plan_not_found;

function Segmented<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void;
}) {
  return (
    <div className="segmented rgm-segmented" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={value === v} className={value === v ? 'on' : ''}
                onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function SwitchRow({ label, hint, checked, onChange }: {
  label: string; hint: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <label className="mini-row report-section-row">
      <Switch checked={checked} onChange={onChange} label={label} />
      <span className="report-section-text">
        <span className="cell-top">{label}</span>
        <span className="cell-sub">{hint}</span>
      </span>
    </label>
  );
}

export default function ProjectPlanOptions({ initiative, plan: given, initial, onBack, onGenerate }: {
  /** The definition (its run options are all here; it has none of its own). */
  definition: ReportDefinition;
  initiative: { id: string; name: string };
  /** The plan on screen; left out, it's fetched for the initiative. */
  plan?: Plan | null;
  initial?: ProjectPlanInitial;
  /** Absent when the modal opens straight on this step. */
  onBack?: () => void;
  onGenerate: (payload: { initiative_id: string | null; options: Record<string, unknown>; notify: boolean }) => void;
}) {
  const [fetched, setFetched] = useState<Plan | null>(null);
  const [loadError, setLoadError] = useState('');
  const [missing, setMissing] = useState(false);
  const plan = given ?? fetched;

  const [current] = useState<string[]>(() => [...(initial?.columns ?? columnPrefsSnapshot().visible)]);
  const [columnsMode, setColumnsMode] = useState<ColumnsMode>('current');
  const [chosen, setChosen] = useState<string[]>(() => current.filter((k) => PICKABLE_KEYS.has(k)));
  const [rangeMode, setRangeMode] = useState<RangeMode>('whole');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [timescale, setTimescale] = useState<Timescale>(() => startingTimescale(initial?.zoom));
  const [paper, setPaper] = useState<Paper>('letter');
  const [includeCompleted, setIncludeCompleted] = useState(true);
  const [critical, setCritical] = useState(!!initial?.critical);
  const [baseline, setBaseline] = useState(!!initial?.baseline);
  const [notify, setNotify] = useState(false);

  useEffect(() => {
    if (given) return undefined;
    let cancelled = false;
    getPlan(initiative.id).then((p) => { if (!cancelled) setFetched(p); }).catch((err: unknown) => {
      if (cancelled) return;
      if (err instanceof ApiError && err.status === 404) setMissing(true);
      else if (err instanceof ApiError && err.status === 403) setLoadError(RUN_ERROR_TEXT.project_plans_view_required);
      else setLoadError("Couldn't load the plan, so the pages can't be counted yet.");
    });
    return () => { cancelled = true; };
  }, [given, initiative.id]);

  // the custom range starts as the plan's own days
  useEffect(() => {
    if (!plan) return;
    const own = planSpan(plan.project_start, plan.project_finish, plan.tasks);
    setFrom((v) => v || dayOf(own.start));
    setTo((v) => v || lastDay(own.start, own.finish));
  }, [plan]);

  const custom = rangeMode === 'custom';
  const datesBad = custom && (!from || !to || Number.isNaN(toMs(from)) || Number.isNaN(toMs(to)) || from > to);
  // what would print: the plan's span, or the custom days cut to it (the
  // API's rule, lib/plans/planPdf); without the plan yet, the days alone
  const span = useMemo(() => (plan ? planSpan(plan.project_start, plan.project_finish, plan.tasks) : null), [plan]);
  const printed = datesBad ? null
    : span ? printRange(span, custom ? from : null, custom ? to : null)
      : custom ? { start: `${from}T00:00`, finish: fromMs(toMs(to) + MS_PER_DAY) } : null;
  const rangeError = datesBad ? 'Choose a From date on or before the To date.'
    : span && custom && !printed
      ? `${RANGE_OUTSIDE} The plan runs ${formatDay(span.start)} → ${formatDay(span.finish)}.`
      : printed && spanTooLong(printed.start, printed.finish) ? RANGE_TOO_LONG : '';

  const estimate = useMemo(() => {
    if (!plan || !printed || rangeError) return null;
    const rows = includeCompleted ? plan.tasks.length : plan.tasks.filter((t) => t.percent_complete < 100).length;
    return estimatePages({ rows, start: printed.start, finish: printed.finish, zoom: timescale, paper });
  }, [plan, printed?.start, printed?.finish, rangeError, includeCompleted, timescale, paper]);

  const columns = columnsMode === 'current' ? current
    : columnsMode === 'default' ? [...DEFAULT_VISIBLE]
      : [...REQUIRED_COLUMNS, ...chosen];

  const blocked = missing || !!rangeError;
  const generate = () => {
    if (blocked) return;
    onGenerate({
      initiative_id: initiative.id,
      options: {
        columns, zoom: timescale, paper, include_completed: includeCompleted, show_critical: critical,
        show_baseline: baseline, ...(custom ? { from, to } : {}),
      },
      notify,
    });
  };

  const taskCount = plan ? (includeCompleted ? plan.tasks.length : plan.tasks.filter((t) => t.percent_complete < 100).length) : 0;

  return (
    <>
      <div className="modal-body">
        <OptionsGrid preview={
          <PreviewCard title="Pages">
            <div className="cell-top">{initiative.name}</div>
            {plan && (
              <div className="cell-sub">
                {formatDay(plan.project_start)}{plan.project_finish ? ` → ${formatDay(plan.project_finish)}` : ''}
                {` · ${taskCount} of ${plan.tasks.length} ${plan.tasks.length === 1 ? 'task' : 'tasks'}`}
              </div>
            )}
            {missing && <div className="pf-error">{NO_PLAN}</div>}
            {loadError && <div className="pf-error">{loadError}</div>}
            {!plan && !missing && !loadError && <p className="page-hint">Counting the pages…</p>}
            {estimate && (
              <>
                <div className="cell-top">{estimateText(estimate)}</div>
                {timescale === 'fit' && <div className="cell-sub">Fit draws it by {ZOOM_WORDS[estimate.zoom]}.</div>}
                {estimate.across > 1 && (
                  <div className="cell-sub">
                    The chart is {estimate.across} pages wide; they print left to right, then down.
                  </div>
                )}
              </>
            )}
            <p className="page-hint">Every task prints: the sheet’s filter and Group by don’t apply.</p>
          </PreviewCard>
        }>
          <OptionGroup title="Columns" hint="The task table’s columns. ID and Task Name are always printed.">
            <Segmented label="Columns" value={columnsMode} onChange={setColumnsMode}
                       options={[['current', 'Current view'], ['default', 'Default'], ['choose', 'Choose…']]} />
            {columnsMode === 'choose' && (
              <ChipPicker options={PICKABLE} selected={chosen} onChange={setChosen} clearAll
                          ariaLabel="Columns to print" placeholder="Add a column…"
                          note="ID and Task Name are always printed." />
            )}
          </OptionGroup>

          <OptionGroup title="Date range">
            <Segmented label="Date range" value={rangeMode} onChange={setRangeMode}
                       options={[['whole', 'Whole project'], ['custom', 'Custom']]} />
            {custom && (
              <div className="pf-form">
                <div>
                  <label htmlFor="pp-from">From</label>
                  <input id="pp-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                </div>
                <div>
                  <label htmlFor="pp-to">To</label>
                  <input id="pp-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
                </div>
              </div>
            )}
            {rangeError && <div className="pf-error">{rangeError}</div>}
          </OptionGroup>

          <OptionGroup title="Timescale" hint="Fit picks the finest timescale that puts the range on one page’s width.">
            <Segmented label="Timescale" value={timescale} onChange={setTimescale} options={TIMESCALES} />
          </OptionGroup>

          <OptionGroup title="Paper" hint="Landscape.">
            <Segmented label="Paper" value={paper} onChange={setPaper}
                       options={[['letter', 'Letter'], ['a4', 'A4']]} />
          </OptionGroup>

          <OptionGroup title="Show">
            <div className="mini-list report-sections">
              <SwitchRow label="Include completed tasks" hint="Tasks at 100% in the table and the chart."
                         checked={includeCompleted} onChange={setIncludeCompleted} />
              <SwitchRow label="Show critical path" hint="Critical tasks and their links in red."
                         checked={critical} onChange={setCritical} />
              <SwitchRow label="Show baseline" hint="The baseline in gray under each bar."
                         checked={baseline} onChange={setBaseline} />
            </div>
          </OptionGroup>

          <OptionGroup title="Notify">
            <div className="mini-list report-sections">
              <SwitchRow label="Notify me" hint="Get an inbox notification when the report is ready."
                         checked={notify} onChange={setNotify} />
            </div>
          </OptionGroup>
        </OptionsGrid>
      </div>
      <div className="modal-foot">
        {onBack && <button type="button" className="btn-ghost" onClick={onBack}>Back</button>}
        <button type="button" className="btn-solid" disabled={blocked} onClick={generate}>Generate Report</button>
      </div>
    </>
  );
}
