/**
 * Import from MS Project or Excel (More › Import…, and the empty state's
 * card): the house rule for bulk actions — dry run, a summary row by row,
 * then apply — in three steps (`.rgm-steps`):
 *
 *  - Choose file: an MS Project XML file, an Excel workbook or a CSV
 *    (FileDropzone; over 20 MB is refused here, before it is sent). Into an
 *    empty plan the mode is a choice (`.segmented`): Fill this empty plan
 *    (the default: the plan takes the file's calendar, project start and
 *    status date too) or Add to the end. A plan with tasks takes the file's
 *    after its last one, and a new plan (none yet: the initiative's route,
 *    `project_plans:add`) always fills. Choosing the file runs the dry run;
 *    a file the API can't read stays here with its message.
 *  - Review: the summary ("18 tasks will be created · 3 problems"), how
 *    the file goes in ("Adds after the last task" / "Fills this empty
 *    plan": the mode the dry run was run in, kept with it and sent with the
 *    apply even if the plan reloads under the open review), the
 *    problems about the whole file, then a row per task (#, Task Name,
 *    Action, Problems, how far the plan's schedule moves it) as the house
 *    list (dir-list, column floors), windowed past VIRTUAL_THRESHOLD rows
 *    against the dialog card's scroll. Import applies it with the version
 *    the review saw; someone else's change since (409 `plan_changed`)
 *    reloads the plan and offers the review again.
 *  - Done: what was created, row by row (the apply's own answer), with
 *    Download summary (.csv). The plan has been read again through usePlan's
 *    reload, so undo and the version start over with it (an import isn't
 *    on the undo stack; the review says so).
 *
 * Escape and the scrim close it as any plan dialog, except while the
 * import is being applied.
 */
import { Fragment, useEffect, useRef, useState } from 'react';

import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/api';
import { ColHead, exportCsv, listGridStyle, listScale, titleFor, type ColumnDef } from '../../lib/listTools';
import {
  MAX_IMPORT_BYTES, importIntoNewPlan, importPlanFile, type ImportMode, type ImportRow, type PlanImport,
} from '../../lib/plans/api';
import { PLAN_ERRORS, planErrorDetail, planErrorText } from '../../lib/plans/errors';
import { VirtualRows } from '../../lib/virtualRows';
import FileDropzone from '../FileDropzone';
import PlanModal from './PlanModal';
import type { PlanController } from './usePlan';

import '../../styles/directory.css';     // the review list (dir-list)
import '../../styles/initiatives.css';   // FileDropzone's .imp-dropzone
import '../../styles/plan-sheet.css';
import '../../styles/plans.css';
import '../../styles/profile.css';       // .btn-solid, .pf-error

export const IMPORT_TITLE = 'Import from MS Project or Excel';
/** The dialog's content width; the review list's floors fit inside it. */
export const IMPORT_WIDTH_PX = 1040;
export const IMPORT_COLUMNS: ColumnDef[] = [
  { key: 'index', label: '#', width: '56px', default: true },
  { key: 'name', label: 'Task Name', width: '1.3fr', default: true, min: 200 },
  { key: 'action', label: 'Action', width: '104px', default: true },
  { key: 'problems', label: 'Problems', width: '2fr', default: true, min: 260 },
  { key: 'moved', label: 'Schedule', width: '184px', default: true },
];
const ACCEPT = '.xml,.xlsx,.csv';
const FORMATS = 'MS Project XML (.xml), Excel workbook (.xlsx) or CSV (.csv), up to 20 MB';

type Step = 'choose' | 'review' | 'done';
const STEPS: readonly (readonly [Step, string])[] = [['choose', 'Choose file'], ['review', 'Review'], ['done', 'Done']];
const MODES: readonly (readonly [ImportMode, string])[] = [['append', 'Add to the end'], ['fill', 'Fill this empty plan']];
const MODE_NOTES: Record<ImportMode | 'new', string> = {
  append: 'The file’s tasks go after this plan’s last task; the plan keeps its calendar and project start.',
  fill: 'The plan takes the file’s calendar, project start and status date, then its tasks.',
  new: 'The new plan takes the file’s calendar, project start and status date, then its tasks.',
};
/** Review's one line on how the previewed file goes into the plan. */
const REVIEW_MODES: Record<ImportMode, string> = {
  append: 'Adds after the last task',
  fill: 'Fills this empty plan',
};
export const PLAN_CHANGED_SINCE = 'Someone else changed this plan after the review, so review the file again '
  + 'before importing.';

const count = (n: number) => n.toLocaleString('en-US');
const tasksText = (n: number) => `${count(n)} task${n === 1 ? '' : 's'}`;
const problemsText = (n: number) => (n === 0 ? 'no problems' : `${count(n)} problem${n === 1 ? '' : 's'}`);
function daysText(moved: number, unit = 'day'): string {
  const n = Number(Math.abs(moved).toFixed(2));
  return `${count(n)} ${unit}${n === 1 ? '' : 's'}`;
}
/** "Moves 3 days later", "Moves 1.5 days earlier": how far the plan's schedule moves a task from the file's start. */
export const movedText = (moved: number) => `Moves ${daysText(moved)} ${moved > 0 ? 'later' : 'earlier'}`;
const movedTitle = (moved: number) => `The plan schedules this task ${daysText(moved, 'working day')} `
  + `${moved > 0 ? 'later' : 'earlier'} than the file has it, from its links, constraints and calendar.`;

/** What a refusal says: a 413 a proxy answered (no code) is the size too. */
function importErrorText(err: unknown): string {
  if (err instanceof ApiError && err.status === 413) return PLAN_ERRORS.file_too_large;
  return planErrorText(err);
}

export default function PlanImportModal({ ctl, initiativeId, onClose }: {
  ctl: Pick<PlanController, 'plan' | 'reload'>;
  initiativeId: string;
  onClose(): void;
}) {
  // the plan the dialog opened on (none: the file makes the initiative's plan)
  const [planId] = useState(() => ctl.plan?.id ?? null);
  const plan = ctl.plan;
  const canFill = planId !== null && plan?.id === planId && plan.tasks.length === 0;
  const [chosen, setChosen] = useState<ImportMode>('fill');
  const mode: ImportMode = planId === null ? 'fill' : canFill ? chosen : 'append';

  const [step, setStep] = useState<Step>('choose');
  const [file, setFile] = useState<File | null>(null);
  /** The dry run's answer, with the mode it was run in: the apply sends
   *  that mode, whatever the plan reloads to under the open review. */
  const [preview, setPreview] = useState<(PlanImport & { mode: ImportMode }) | null>(null);
  const [result, setResult] = useState<PlanImport | null>(null);
  const [reading, setReading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  /** The apply met someone else's change (409 plan_changed): review again. */
  const [stale, setStale] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  /** The latest dry run: an earlier one answering late is dropped. */
  const runs = useRef(0);

  // set again on every mount: StrictMode mounts, unmounts and mounts again
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  // a new step starts at its top (the summary), wherever the last one was scrolled
  useEffect(() => {
    const card = rootRef.current?.closest<HTMLElement>('.modal-card');
    if (card) card.scrollTop = 0;
  }, [step]);

  // a step whose control went away (the file field turned busy, a step
  // changed) leaves focus on the page: put it back in the dialog
  useEffect(() => {
    if (reading || applying) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    if (step === 'choose' && inputRef.current) inputRef.current.focus();
    else rootRef.current?.closest<HTMLElement>('.modal-card')?.focus();
  }, [step, reading, applying]);

  const review = async (f: File) => {
    setError('');
    setStale(false);
    if (f.size > MAX_IMPORT_BYTES) {
      runs.current += 1;
      setError(PLAN_ERRORS.file_too_large);
      setStep('choose');
      return;
    }
    const run = ++runs.current;
    const current = () => alive.current && run === runs.current;
    const sent = mode;
    setReading(true);
    try {
      const out = planId === null
        ? await importIntoNewPlan(initiativeId, f, { dryRun: true })
        : await importPlanFile(planId, f, { dryRun: true, mode: sent });
      if (!current()) return;
      setPreview({ ...out, mode: sent });
      setStep('review');
    } catch (err) {
      if (!current()) return;
      setError(importErrorText(err));
      setStep('choose');
      // someone else made the initiative's plan meanwhile: show it behind
      if (planErrorDetail(err)?.code === 'plan_exists') void ctl.reload();
    } finally {
      if (current()) setReading(false);
    }
  };

  const onFile = (f: File | null) => {
    setFile(f);
    setError('');
    if (f) void review(f);
    else {
      runs.current += 1;
      setReading(false);
    }
  };

  const apply = async () => {
    if (!file || !preview) return;
    setError('');
    setApplying(true);
    try {
      const out = planId === null
        ? await importIntoNewPlan(initiativeId, file, { dryRun: false })
        : await importPlanFile(planId, file, {
          dryRun: false, mode: preview.mode, baseVersion: preview.version ?? undefined,
        });
      // the plan read again: its new tasks, version and an empty undo stack
      await ctl.reload();
      if (!alive.current) return;
      setResult(out);
      setStep('done');
    } catch (err) {
      if (!alive.current) return;
      const code = planErrorDetail(err)?.code;
      if (code === 'plan_changed') setStale(true);
      else setError(importErrorText(err));
      if (code === 'plan_changed' || code === 'plan_exists') void ctl.reload();
    } finally {
      if (alive.current) setApplying(false);
    }
  };

  const back = () => {
    setError('');
    setStale(false);
    setStep('choose');
  };

  const at = STEPS.findIndex(([key]) => key === step);
  const steps = (
    <div className="rgm-steps">
      {STEPS.map(([key, label], i) => (
        <Fragment key={key}>
          {i > 0 && <span className="rgm-step-sep" />}
          <span className={`rgm-step${i === at ? ' on' : ''}${i < at ? ' done' : ''}`}
                aria-current={i === at ? 'step' : undefined}>
            <span className="rgm-step-num">{i + 1}</span>
            <span className="rgm-step-label">{label}</span>
          </span>
        </Fragment>
      ))}
    </div>
  );

  let body;
  let footer;
  if (step === 'choose') {
    body = (
      <div className="pln-import" ref={rootRef}>
        {canFill ? (
          <div className="pln-import-mode">
            <div className="segmented" role="group" aria-label="How to import">
              {MODES.map(([value, label]) => (
                <button key={value} type="button" className={mode === value ? 'on' : ''} aria-pressed={mode === value}
                        disabled={reading} onClick={() => setChosen(value)}>
                  {label}
                </button>
              ))}
            </div>
            <p className="pln-note">{MODE_NOTES[mode]}</p>
          </div>
        ) : (
          <p className="pln-note">{MODE_NOTES[planId === null ? 'new' : 'append']}</p>
        )}
        <FileDropzone file={file} onFile={onFile} busy={reading} inputRef={inputRef} accept={ACCEPT} hint={FORMATS} />
        <p className="pln-note">
          From MS Project, use Save As and choose XML Format: an .mpp file can’t be read.
        </p>
        {reading && <p className="pln-note" role="status">Reading the file…</p>}
        {error && <p className="pf-error" role="alert">{error}</p>}
      </div>
    );
    footer = (
      <>
        <button type="button" className="btn-solid" disabled={!file || reading} onClick={() => file && void review(file)}>
          Review
        </button>
        <button type="button" className="mini-btn" onClick={onClose}>Cancel</button>
      </>
    );
  } else if (step === 'review' && preview) {
    const created = preview.summary.created;
    body = (
      <div className="pln-import" ref={rootRef}>
        <p className="pln-import-sum">
          <b>{tasksText(created)} will be created</b> · {problemsText(preview.summary.problems)}
        </p>
        {/* the mode the review was run in (a new plan is always made from the file) */}
        {planId !== null && <p className="pln-note">{REVIEW_MODES[preview.mode]}</p>}
        <FileProblems problems={preview.problems} />
        {preview.rows.length
          ? <ImportRows rows={preview.rows} done={false} />
          : <p className="pln-note">The file has no tasks to import.</p>}
        <p className="pln-note">Undo can’t take an import back, so check the tasks before importing.</p>
      </div>
    );
    footer = (
      <>
        <button type="button" className="btn-solid" disabled={!preview.rows.length || applying || reading || stale}
                onClick={() => void apply()}>
          {applying ? 'Importing…' : `Import ${tasksText(created)}`}
        </button>
        <button type="button" className="mini-btn" disabled={applying || reading} onClick={back}>Back</button>
        <button type="button" className="mini-btn" disabled={applying} onClick={onClose}>Cancel</button>
        {stale ? (
          <>
            <span className="pf-error" role="alert">{PLAN_CHANGED_SINCE}</span>
            <button type="button" className="mini-btn" disabled={reading} onClick={() => file && void review(file)}>
              Review again
            </button>
          </>
        ) : error && <span className="pf-error" role="alert">{error}</span>}
      </>
    );
  } else if (result) {
    const download = () => exportCsv<ImportRow>('plan-import-summary', [
      ['#', (r) => String(r.index)],
      ['Task Name', (r) => r.name],
      ['Action', () => 'Created'],
      ['Problems', (r) => r.problems.join(' ')],
      ['Schedule', (r) => (r.moved_days === null ? '' : movedText(r.moved_days))],
    ], result.rows);
    body = (
      <div className="pln-import" ref={rootRef}>
        <p className="pln-import-sum">
          <b>{tasksText(result.summary.created)} created</b> · {problemsText(result.summary.problems)}
        </p>
        <FileProblems problems={result.problems} />
        {result.rows.length > 0 && <ImportRows rows={result.rows} done />}
      </div>
    );
    footer = (
      <>
        <button type="button" className="btn-solid" onClick={onClose}>Done</button>
        <button type="button" className="mini-btn" onClick={download}>Download summary (.csv)</button>
      </>
    );
  }

  return (
    <PlanModal title={IMPORT_TITLE} size="xwide" onClose={onClose} busy={applying} steps={steps}
               description={planId === null
                 ? 'Make this initiative’s plan from an MS Project XML file, an Excel workbook or a CSV. '
                   + 'You review every task before the plan is made.'
                 : 'Add tasks from an MS Project XML file, an Excel workbook or a CSV. You review every task '
                   + 'before anything changes.'}
               footer={footer}>
      {body}
    </PlanModal>
  );
}

/** The problems about the whole file (its calendar not taken, an
 *  assignment naming no task), above the rows. */
function FileProblems({ problems }: { problems: string[] }) {
  if (!problems.length) return null;
  return (
    <ul className="pln-import-problems" aria-label="About the whole file">
      {problems.map((p, i) => <li key={i}>{p}</li>)}
    </ul>
  );
}

/** The file's tasks as the house list: #, Task Name, Action, Problems and
 *  how far the plan's schedule moves each, windowed for a large file. */
function ImportRows({ rows, done }: { rows: ImportRow[]; done: boolean }) {
  const { preferences } = useAuth();
  const grid = listGridStyle(IMPORT_COLUMNS, [], undefined, listScale(preferences?.list_size));
  const rowStyle = { gridTemplateColumns: grid.gridTemplateColumns, minWidth: grid.minWidth };
  return (
    <div className="dir-list list-scroll pln-import-rows">
      <div className="list-head" style={rowStyle}>
        {IMPORT_COLUMNS.map((c) => <ColHead key={c.key} col={c} />)}
      </div>
      <VirtualRows rows={rows} scroller=".modal-card" renderRow={(r, vp) => (
        <div key={r.index} className="dir-row" {...vp} style={{ ...vp?.style, minWidth: rowStyle.minWidth }}>
          <div className="row-main" style={rowStyle}>
            <div className="cell"><span className="mono">{r.index}</span></div>
            <div className="cell">
              <span className="cell-top cell-line" title={titleFor(r.name || '—')}>{r.name || '—'}</span>
            </div>
            <div className="cell">
              <span className="chip c-green"><span className="dot" />{done ? 'Created' : 'Create'}</span>
            </div>
            <div className="cell">
              {r.problems.length
                ? r.problems.map((p, i) => <div key={i} className="cell-top">{p}</div>)
                : <span className="cell-sub">—</span>}
            </div>
            <div className="cell">
              {r.moved_days !== null && (
                <span className="chip c-amber" title={movedTitle(r.moved_days)}>
                  <span className="dot" />{movedText(r.moved_days)}
                </span>
              )}
            </div>
          </div>
        </div>
      )} />
    </div>
  );
}
