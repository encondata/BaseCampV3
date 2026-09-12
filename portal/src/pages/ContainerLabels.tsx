/**
 * /labels/containers — V3 port of V2's Container Labels page: pick an
 * initiative, pick its containers (with per-row/bulk tags), then either
 * download the Avery 5164 PDF straight from the browser (V2's own
 * instant path, byte-for-byte via `containerLabelSheet.ts`) or queue it
 * as a report run (the same PDF, generated server-side, attached to the
 * initiative and the requester's inbox like every other report).
 *
 * Laid out as the same stacked three-step band `GenerateLabels.tsx`
 * introduced (`StepCard` over `ChoiceCard`/`InitiativeSummary` from
 * `components/reports/ReportOptionsLayout`) — reimplemented locally here
 * (rather than importing GenerateLabels' own private `StepCard`) since
 * this page owns a different file and the piece is a few lines of JSX,
 * not worth a shared export.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import {
  ApiError, createReportRun, getReportRun, getReportRunDownloadUrl, listContainers, listInitiatives,
  listReportDefinitions, type ContainerItem, type InitiativeItem, type ReportDefinition, type ReportRun,
} from '../lib/api';
import { buildRunOptions, tagsInUse, toPdfInput } from '../lib/containerLabels';
import { visibleInitiativesForGenerate } from '../lib/generateLabels';
import { openPresigned } from '../lib/reports';
import ComboBox from '../components/ComboBox';
import ContainerPickList from '../components/labels/ContainerPickList';
import { InitiativeSummary } from '../components/reports/ReportOptionsLayout';
import { Switch } from '../components/Switch';
import { browserContainerLabelAdapters, loadTagImages } from '../labels/containerLabelAdapters.browser';
import { buildContainerLabelPdf, containerLabelsFilename, TAG_TYPES, type TagKey } from '../labels/containerLabelSheet';
import '../styles/directory.css';
import '../styles/dashboard.css';
import '../styles/reports.css';
import '../styles/labels.css';

const POLL_MS = 2000;

function StepCard({ step, title, hint, children }: {
  step: string; title: string; hint?: ReactNode; children: ReactNode;
}) {
  return (
    <section className="cl-step" aria-label={title}>
      <div className="cl-step-head">
        <span className="eyebrow">{step}</span>
        <div className="modal-section">{title}</div>
        {hint && <p className="page-hint">{hint}</p>}
      </div>
      <div className="cl-step-body">{children}</div>
    </section>
  );
}

export default function ContainerLabels() {
  const [initiatives, setInitiatives] = useState<InitiativeItem[] | null>(null);
  const [initiativeId, setInitiativeId] = useState('');
  const [initiativesError, setInitiativesError] = useState('');

  const [containers, setContainers] = useState<ContainerItem[] | null>(null);
  const [containersError, setContainersError] = useState('');

  const [selected, setSelected] = useState<string[]>([]);
  const [tags, setTags] = useState<Record<string, TagKey>>({});

  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState('');
  const [pdfStatus, setPdfStatus] = useState('');

  const [definitions, setDefinitions] = useState<ReportDefinition[] | null>(null);
  const [notify, setNotify] = useState(false);
  const [run, setRun] = useState<ReportRun | null>(null);
  const [runError, setRunError] = useState('');
  const closedRef = useRef(false);

  useEffect(() => {
    closedRef.current = false;
    listInitiatives().then(setInitiatives).catch(() => setInitiativesError("Couldn't load initiatives."));
    listReportDefinitions().then(setDefinitions).catch(() => setDefinitions([]));
    return () => { closedRef.current = true; };
  }, []);

  useEffect(() => {
    if (!initiativeId) { setContainers(null); setContainersError(''); return; }
    let cancelled = false;
    setContainers(null);
    setContainersError('');
    setSelected([]);
    setTags({});
    setRun(null);
    setRunError('');
    setPdfError('');
    setPdfStatus('');
    listContainers({ initiative_id: initiativeId })
      .then((rows) => { if (!cancelled) setContainers(rows); })
      .catch((err) => {
        if (cancelled) return;
        setContainersError(err instanceof ApiError ? err.message : "Couldn't load containers.");
      });
    return () => { cancelled = true; };
  }, [initiativeId]);

  // Poll the queued report run until it settles.
  useEffect(() => {
    if (!run || (run.status !== 'queued' && run.status !== 'running')) return;
    const id = run.id;
    const timer = setInterval(() => {
      getReportRun(id).then((next) => { if (!closedRef.current) setRun(next); }).catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [run]);

  const pickerOptions = useMemo(
    () => visibleInitiativesForGenerate(initiatives ?? [])
      .map((i) => ({ value: i.id, label: i.name, sub: i.client_name })),
    [initiatives],
  );
  const pickedInitiative = initiatives?.find((i) => i.id === initiativeId) ?? null;
  const definition = definitions?.find((d) => d.report_type === 'container_labels') ?? null;

  const selectedContainers = useMemo(
    () => (containers ?? []).filter((c) => selected.includes(c.id)),
    [containers, selected],
  );
  const inUseTags = tagsInUse(selected, tags);
  const canGenerate = !!pickedInitiative && selected.length > 0;
  const runActive = !!run && (run.status === 'queued' || run.status === 'running');

  const downloadPdf = async () => {
    if (!pickedInitiative || selectedContainers.length === 0) return;
    setPdfBusy(true);
    setPdfError('');
    setPdfStatus('Generating PDF…');
    try {
      const tagImages = await loadTagImages(inUseTags);
      const input = { ...toPdfInput(pickedInitiative, selectedContainers, tags), tagImages };
      // `JsPdfLike` (containerLabelSheet.ts) only declares the drawing
      // surface `buildContainerLabelPdf` itself calls — not `.save`, which
      // only the caller needs — so the real jsPDF instance it returns is
      // narrowed back in here rather than widening that shared interface.
      const doc = buildContainerLabelPdf(input, browserContainerLabelAdapters) as unknown as {
        save(filename: string): void;
      };
      doc.save(containerLabelsFilename(pickedInitiative.name, pickedInitiative.id));
      setPdfStatus(`Generated ${selectedContainers.length} container label sheet${selectedContainers.length === 1 ? '' : 's'}.`);
    } catch (err) {
      setPdfStatus('');
      setPdfError(err instanceof Error ? err.message : 'Failed to generate labels.');
    } finally {
      setPdfBusy(false);
    }
  };

  const generateReport = async () => {
    if (!pickedInitiative || !definition || selectedContainers.length === 0) return;
    setRunError('');
    setRun(null);
    try {
      const created = await createReportRun({
        definition_id: definition.id, initiative_id: pickedInitiative.id,
        options: buildRunOptions(selected, tags), notify,
      });
      setRun(created);
    } catch (err) {
      setRunError(err instanceof ApiError ? err.message : "Couldn't start the report.");
    }
  };

  const download = async () => {
    if (!run) return;
    try {
      await openPresigned(() => getReportRunDownloadUrl(run.id));
    } catch (err) {
      setRunError(err instanceof ApiError ? err.message : "Couldn't fetch the download link.");
    }
  };

  return (
    <div className="portal-page cl-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Labels</div>
          <h1 className="page-title">Container Labels</h1>
          <p className="page-hint">
            Avery 5164 sheets: one page per container with five barcode labels and one QR info label.
          </p>
        </div>
      </div>

      {initiativesError && <div className="pf-error" style={{ marginBottom: 12 }}>{initiativesError}</div>}

      <div className="cl-steps">
        <StepCard step="Step 1" title="Initiative"
                  hint="Pick the initiative whose containers need labels.">
          <div className="glabels-initiative">
            <ComboBox options={pickerOptions} value={initiativeId}
                      onChange={setInitiativeId} placeholder="Choose an initiative…" clearable />
            {!initiativeId && (
              <p className="page-hint">Pick an initiative to see its details and containers here.</p>
            )}
            {initiativeId && pickedInitiative && (
              <div>
                <InitiativeSummary
                  initiative={{
                    name: pickedInitiative.name, clientName: pickedInitiative.client_name,
                    statusLabel: pickedInitiative.status_label, statusColor: pickedInitiative.status_color,
                    scheduledStart: pickedInitiative.scheduled_start,
                    originName: pickedInitiative.origin_site_name,
                    destinationName: pickedInitiative.destination_site_name,
                  }}
                  emptyText="Pick an initiative to see its details here."
                />
                {containers !== null && (
                  <p className="page-hint">
                    {containers.length} container{containers.length === 1 ? '' : 's'} on this initiative.
                  </p>
                )}
              </div>
            )}
          </div>
        </StepCard>

        <StepCard step="Step 2" title="Containers"
                  hint="Select the containers to label. Set a tag per container, or in bulk for the selection.">
          {!initiativeId && <p className="page-hint">Select an initiative to view containers</p>}
          {initiativeId && containersError && <div className="pf-error">{containersError}</div>}
          {initiativeId && !containersError && containers === null && (
            <p className="page-hint">Loading containers…</p>
          )}
          {initiativeId && !containersError && containers !== null && containers.length === 0 && (
            <p className="page-hint">No containers on this initiative</p>
          )}
          {initiativeId && !containersError && containers !== null && containers.length > 0 && (
            <ContainerPickList containers={containers} selected={selected} tags={tags}
                                onSelectedChange={setSelected} onTagsChange={setTags} />
          )}
        </StepCard>

        <StepCard step="Step 3" title="Generate"
                  hint="Download instantly, or queue it as a report so it's attached to the initiative.">
          <div>
            <p className="page-hint">
              {selected.length === 0
                ? 'Select containers to generate label sheets.'
                : `${selected.length} container${selected.length === 1 ? '' : 's'} selected — ${selected.length} sheet${selected.length === 1 ? '' : 's'}.`}
            </p>
            {inUseTags.length > 0 && (
              <div className="cl-generate-summary">
                {inUseTags.map((key) => <span key={key} className="chip tag">{TAG_TYPES[key].label}</span>)}
              </div>
            )}

            <div className="cl-generate-actions">
              <button type="button" className="btn-solid" disabled={!canGenerate || pdfBusy}
                      onClick={() => void downloadPdf()}>
                {pdfBusy ? 'Generating…' : 'Download PDF'}
              </button>
              <button type="button" className="mini-btn" disabled={!canGenerate || !definition || runActive}
                      onClick={() => void generateReport()}>
                Generate as report
              </button>
            </div>
            {!definition && definitions !== null && (
              <p className="page-hint">The Container Labels report isn&apos;t set up yet — ask an admin to add it.</p>
            )}
            {pdfError && <div className="pf-error">{pdfError}</div>}
            {!pdfError && pdfStatus && <p className="page-hint">{pdfStatus}</p>}

            {run && (
              <div className="glabels-progress">
                {runActive && <p className="page-hint">{run.status === 'running' ? 'Generating…' : 'Queued…'}</p>}
                {run.status === 'completed' && (
                  <div className="glabels-progress-status">
                    <span className="cell-top">{run.filename}</span>
                    <button type="button" className="btn-solid" onClick={() => void download()}>Download</button>
                  </div>
                )}
                {run.status === 'failed' && <div className="pf-error">{run.error ?? 'The report failed.'}</div>}
              </div>
            )}
            {runError && <div className="pf-error">{runError}</div>}

            <div className="mini-list report-sections" style={{ marginTop: 8 }}>
              <label className="mini-row report-section-row">
                <Switch checked={notify} onChange={setNotify} />
                <span className="report-section-text">
                  <span className="cell-top">Notify me when finished</span>
                  <span className="cell-sub">Only applies to Generate as report.</span>
                </span>
              </label>
            </div>
          </div>
        </StepCard>
      </div>
    </div>
  );
}
