/**
 * GenerateReportModal's options step for `report_type === 'timesheet'`.
 * Unlike the move reports there is no initiative pick step: the optional
 * job is one of the filters here (it becomes the run's `initiative_id`).
 * Same OptionsGrid / PreviewCard / OptionGroup / ChoiceCard idiom as Move
 * Scan History; the preview is the same gather a run uses, refreshed
 * (debounced) as the options change.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  ApiError, getPunchOptions, getTimesheetPreview, listInitiatives, listWorkerOptions,
  type ReportDefinition, type TimesheetPreview,
} from '../../lib/api';
import { sortNatural } from '../../lib/naturalSort';
import {
  buildTimesheetRunOptions, quickRange, timesheetDateError, timesheetDefaults,
  timesheetOptionsValid, TIMESHEET_STATUS_CARDS, TIMESHEET_STATUSES, TIMESHEET_VIEW_CARDS,
  TIMESHEET_VIEWS,
  type QuickRangeKind, type TimesheetFormat, type TimesheetStatus, type TimesheetView,
} from '../../lib/timesheetReport';
import { formatMinutes } from '../../lib/timeFormat';
import ComboBox, { type ComboOption } from '../ComboBox';
import { Switch } from '../Switch';
import { ChoiceCard, OptionGroup, OptionsGrid, PreviewCard } from './ReportOptionsLayout';

export const PREVIEW_DEBOUNCE_MS = 400;

const QUICK_PICKS: { kind: QuickRangeKind; label: string }[] = [
  { kind: 'this_week', label: 'This week' }, { kind: 'last_week', label: 'Last week' },
  { kind: 'this_month', label: 'This month' }, { kind: 'last_month', label: 'Last month' },
];

export interface TimesheetInitial {
  from: string; to: string; personId: string; initiativeId: string; siteId: string;
  statuses: TimesheetStatus[];
}

const toggle = <T extends string>(list: T[], item: T): T[] =>
  list.includes(item) ? list.filter((x) => x !== item) : [...list, item];

export default function TimesheetOptions({ definition, onBack, onGenerate, initial }: {
  definition: ReportDefinition;
  /** Absent when the modal opens straight on this step (nothing to go back to). */
  onBack?: () => void;
  onGenerate: (payload: {
    initiative_id: string | null; options: Record<string, unknown>; notify: boolean;
  }) => void;
  initial?: Partial<TimesheetInitial>;
}) {
  const defaults = useMemo(() => timesheetDefaults(definition), [definition]);
  const [range0] = useState(() => quickRange('this_month', new Date()));

  const [from, setFrom] = useState(initial?.from || range0.from);
  const [to, setTo] = useState(initial?.to || range0.to);
  const [personId, setPersonId] = useState(initial?.personId ?? '');
  const [jobId, setJobId] = useState(initial?.initiativeId ?? '');
  const [siteId, setSiteId] = useState(initial?.siteId ?? '');
  const [statuses, setStatuses] = useState<TimesheetStatus[]>(
    initial?.statuses?.length ? initial.statuses : defaults.statuses);
  const [views, setViews] = useState<TimesheetView[]>(defaults.views);
  const [format, setFormat] = useState<TimesheetFormat>(defaults.format);
  const [notify, setNotify] = useState(false);

  const [people, setPeople] = useState<ComboOption[]>([]);
  const [jobs, setJobs] = useState<ComboOption[]>([]);
  const [sites, setSites] = useState<ComboOption[]>([]);
  const [listsFailed, setListsFailed] = useState(false);

  // Person: the workers list the Timesheet screen uses. Job: every
  // unarchived initiative. Site: the Timesheet screen's own source,
  // `getPunchOptions().sites` — every unarchived site, and (unlike
  // `listSites`) it needs no sites:view, only time access.
  useEffect(() => {
    let cancelled = false;
    const fail = () => { if (!cancelled) setListsFailed(true); };
    listWorkerOptions().then((l) => {
      if (!cancelled) {
        setPeople(sortNatural(l, (w) => w.display_name)
          .map((w) => ({ value: w.person_id, label: w.display_name })));
      }
    }).catch(fail);
    listInitiatives().then((l) => {
      if (!cancelled) {
        setJobs(sortNatural(l.filter((j) => !j.archived_at), (j) => j.name)
          .map((j) => ({ value: j.id, label: j.name })));
      }
    }).catch(fail);
    getPunchOptions().then((o) => {
      if (!cancelled) {
        setSites(sortNatural(o.sites, (s) => s.name).map((s) => ({ value: s.id, label: s.name })));
      }
    }).catch(fail);
    return () => { cancelled = true; };
  }, []);

  const valid = timesheetOptionsValid({ from, to, statuses, views });
  const dateError = timesheetDateError(from, to);

  const [preview, setPreview] = useState<TimesheetPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const requestToken = useRef(0);
  const statusKey = statuses.join(',');

  // Debounced preview. Every change bumps the token, so a response that
  // lands after a newer request started (or after unmount) is ignored.
  useEffect(() => {
    const token = ++requestToken.current;
    if (!valid) { setPreview(null); setLoading(false); setPreviewError(''); return; }
    setLoading(true);
    const timer = setTimeout(() => {
      getTimesheetPreview({
        from, to,
        ...(personId ? { person_id: personId } : {}),
        ...(jobId ? { initiative_id: jobId } : {}),
        ...(siteId ? { site_id: siteId } : {}),
        statuses: TIMESHEET_STATUSES.filter((s) => statusKey.split(',').includes(s)),
      }).then((p) => {
        if (token !== requestToken.current) return;
        setPreview(p); setPreviewError(''); setLoading(false);
      }).catch((err) => {
        if (token !== requestToken.current) return;
        setPreview(null); setLoading(false);
        if (err instanceof ApiError && err.status === 403) {
          setPreviewError('You need permission to view time to run this report.');
        } else if (err instanceof ApiError && err.status === 422) {
          setPreviewError('');   // the form's own validation already covers it
        } else {
          setPreviewError("Couldn't load the preview.");
        }
      });
    }, PREVIEW_DEBOUNCE_MS);
    return () => { clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, personId, jobId, siteId, statusKey, valid]);
  useEffect(() => () => { requestToken.current += 1; }, []);

  const tooMany = !!preview?.too_many;
  const generate = () => {
    onGenerate({
      initiative_id: jobId || null,
      options: buildTimesheetRunOptions({ from, to, personId, siteId, statuses, views, format }),
      notify,
    });
  };

  return (
    <>
      <div className="modal-body">
        <OptionsGrid preview={
          <PreviewCard title="Preview">
            {!valid && (
              <p className="page-hint">
                Choose a valid date range and at least one status and view to see a preview.
              </p>
            )}
            {valid && loading && !preview && <p className="page-hint">Loading preview…</p>}
            {previewError && <div className="pf-error">{previewError}</div>}
            {valid && tooMany && (
              <p className="pf-notice">
                That range has more than 20,000 entries — narrow the dates or add a filter.
              </p>
            )}
            {valid && preview && !tooMany && (
              <div className="dash-kpis" aria-busy={loading}>
                <div className="dash-kpi">
                  <span className="dash-kpi-label">Entries</span>
                  <span className="dash-kpi-value">{preview.entries}</span>
                </div>
                <div className="dash-kpi">
                  <span className="dash-kpi-label">People</span>
                  <span className="dash-kpi-value">{preview.people}</span>
                </div>
                <div className="dash-kpi">
                  <span className="dash-kpi-label">Days</span>
                  <span className="dash-kpi-value">{preview.days}</span>
                </div>
                <div className="dash-kpi">
                  <span className="dash-kpi-label">Approved</span>
                  <span className="dash-kpi-value">{formatMinutes(preview.approved_minutes)}</span>
                </div>
                <div className="dash-kpi">
                  <span className="dash-kpi-label">Pending</span>
                  <span className="dash-kpi-value">{formatMinutes(preview.pending_minutes)}</span>
                </div>
                <div className="dash-kpi">
                  <span className="dash-kpi-label">Flagged</span>
                  <span className="dash-kpi-value">{preview.flagged_entries}</span>
                </div>
              </div>
            )}
          </PreviewCard>
        }>
          <OptionGroup title="Dates">
            <div className="pf-form">
              <div>
                <label htmlFor="ts-from">From</label>
                <input id="ts-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div>
                <label htmlFor="ts-to">To</label>
                <input id="ts-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
            </div>
            <div className="ts-quick">
              {QUICK_PICKS.map((q) => (
                <button key={q.kind} type="button" className="mini-btn"
                        onClick={() => {
                          const r = quickRange(q.kind, new Date());
                          setFrom(r.from); setTo(r.to);
                        }}>
                  {q.label}
                </button>
              ))}
            </div>
            {dateError && <div className="pf-error">{dateError}</div>}
          </OptionGroup>

          <OptionGroup title="Filters">
            <div className="pf-form">
              <div className="full">
                <label htmlFor="ts-person">Person</label>
                <ComboBox inputId="ts-person" ariaLabel="Person" placeholder="Everyone"
                          value={personId} onChange={setPersonId}
                          options={[{ value: '', label: 'Everyone' }, ...people]} />
              </div>
              <div className="full">
                <label htmlFor="ts-job">Job</label>
                <ComboBox inputId="ts-job" ariaLabel="Job" placeholder="All jobs"
                          value={jobId} onChange={setJobId}
                          options={[{ value: '', label: 'All jobs' }, ...jobs]} />
              </div>
              <div className="full">
                <label htmlFor="ts-site">Site</label>
                <ComboBox inputId="ts-site" ariaLabel="Site" placeholder="All sites"
                          value={siteId} onChange={setSiteId}
                          options={[{ value: '', label: 'All sites' }, ...sites]} />
              </div>
            </div>
            {listsFailed && <div className="pf-error">Couldn&apos;t load every filter list.</div>}
          </OptionGroup>

          <OptionGroup title="Include">
            <div className="rgm-choice-cards ts-choice-grid" role="group" aria-label="Include">
              {TIMESHEET_STATUSES.map((s) => (
                <ChoiceCard key={s} variant="checkbox" title={TIMESHEET_STATUS_CARDS[s].title}
                            description={TIMESHEET_STATUS_CARDS[s].description}
                            selected={statuses.includes(s)}
                            onSelect={() => setStatuses((l) => toggle(l, s))} />
              ))}
            </div>
          </OptionGroup>

          <OptionGroup title="Views">
            <div className="rgm-choice-cards ts-choice-grid" role="group" aria-label="Views">
              {TIMESHEET_VIEWS.map((v) => (
                <ChoiceCard key={v} variant="checkbox" title={TIMESHEET_VIEW_CARDS[v].title}
                            description={TIMESHEET_VIEW_CARDS[v].description}
                            selected={views.includes(v)}
                            onSelect={() => setViews((l) => toggle(l, v))} />
              ))}
            </div>
          </OptionGroup>

          <OptionGroup title="Format">
            <div className="rgm-choice-cards" role="radiogroup" aria-label="Format">
              <ChoiceCard title="Excel workbook" description="Day and Punch sheets, with decimal hours"
                          selected={format === 'xlsx'} onSelect={() => setFormat('xlsx')} />
              <ChoiceCard title="PDF document"
                          description="Landscape, printable, with a document tracking barcode"
                          selected={format === 'pdf'} onSelect={() => setFormat('pdf')} />
            </div>
          </OptionGroup>

          <OptionGroup title="Notify">
            <div className="mini-list report-sections">
              <label className="mini-row report-section-row">
                <Switch checked={notify} onChange={setNotify} />
                <span className="report-section-text">
                  <span className="cell-top">Notify me</span>
                  <span className="cell-sub">Get an inbox notification when the report is ready.</span>
                </span>
              </label>
            </div>
          </OptionGroup>
        </OptionsGrid>
      </div>
      <div className="modal-foot">
        {onBack && <button type="button" className="btn-ghost" onClick={onBack}>Back</button>}
        <button type="button" className="btn-solid" disabled={!valid || tooMany} onClick={generate}>
          Generate Report
        </button>
      </div>
    </>
  );
}
