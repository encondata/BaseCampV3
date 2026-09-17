/**
 * /labels/print — V3 port of V2's Print Labels page (PrintLabels.jsx):
 * pick an initiative and a label type, connect a Zebra printer over
 * WebUSB, pick assets, print. Labels come from `generated_labels` through
 * the bundle endpoint and every online load is written to the IndexedDB
 * cache (`lib/labelCache.ts`) so the dock keeps printing when the network
 * drops. Behavior contract: docs/superpowers/specs/2026-09-12-print-labels-design.md.
 *
 * Layout mirrors V2: header + status notice, three side-by-side step
 * cards (Initiative / Label type / Printer), the asset list card, the
 * Ready to print bar. Modals: Print settings, Printing labels (batch),
 * Offline labels.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import {
  getGeneratedLabelBundle, listInitiativeAssets, listInitiatives, listLabelVocab,
  type GeneratedLabelBundle, type InitiativeAssetRow, type InitiativeItem, type LabelVocab,
} from '../lib/api';
import { relativeTime } from '../lib/format';
import { visibleInitiativesForGenerate } from '../lib/generateLabels';
import * as labelCache from '../lib/labelCache';
import { vocabLabel, vocabOfKind } from '../lib/labels';
import {
  LABEL_TYPE_CUSTOM, applyPrintSettings, batchBounds, batchCount, blankLabelsZpl, bundleByEntity,
  labelStatusFor, missingLabelIds, printOrder, rackOf, readPrintSettings, settingsModified,
  staleLabelCount, writePrintSettings, type LabelStatus, type PrintSettings,
} from '../lib/printLabels';
import { useZebraPrinter } from '../lib/useZebraPrinter';
import ComboBox from '../components/ComboBox';
import OfflineCacheModal from '../components/labels/OfflineCacheModal';
import PrintAssetList from '../components/labels/PrintAssetList';
import PrintBatchModal, { type BatchPrintState } from '../components/labels/PrintBatchModal';
import PrintSettingsModal from '../components/labels/PrintSettingsModal';
import { ChoiceCard, InitiativeSummary, summaryFromInitiative } from '../components/reports/ReportOptionsLayout';
import '../styles/directory.css';
import '../styles/dashboard.css';
import '../styles/reports.css';
import '../styles/labels.css';

const LABEL_DELAY_MS = 100;
const AUTO_NEXT_SECONDS = 5;

// Print Labels doesn't walk containers yet (that's a later phase-two task),
// so the type picker here still excludes the container-shaped label types
// even though Generate Labels now offers them.
const NOT_YET_PRINTABLE_TYPES: ReadonlySet<string> = new Set(['container', 'container_info']);

interface Notice { type: 'success' | 'info' | 'warning' | 'error'; message: string; action?: { label: string; onClick: () => void } }

function StepCard({ step, title, hint, children }: { step: string; title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="plabels-step" aria-label={title}>
      <div className="plabels-step-head">
        <span className="eyebrow">{step}</span>
        <div className="modal-section">{title}</div>
        {hint && <p className="page-hint">{hint}</p>}
      </div>
      <div className="plabels-step-body">{children}</div>
    </section>
  );
}

const isNetworkFailure = (err: unknown) => !(err instanceof Error && 'status' in err);

export default function PrintLabels() {
  const printer = useZebraPrinter();

  const [initiatives, setInitiatives] = useState<InitiativeItem[] | null>(null);
  const [vocab, setVocab] = useState<LabelVocab[]>([]);
  const [initiativeId, setInitiativeId] = useState('');
  const [labelType, setLabelType] = useState('');
  const [customZpl, setCustomZpl] = useState('');
  const [roster, setRoster] = useState<InitiativeAssetRow[] | null>(null);
  const [rosterLoading, setRosterLoading] = useState(false);
  const [bundle, setBundle] = useState<GeneratedLabelBundle | null>(null);
  const [bundleLoading, setBundleLoading] = useState(false);
  // cached_at of what we're serving; roster and bundle can fall back to cache independently, so
  // each gets its own state — the banner shows whichever is set (roster takes priority).
  const [rosterOffline, setRosterOffline] = useState<string | null>(null);
  const [bundleOffline, setBundleOffline] = useState<string | null>(null);
  const offlineSince = rosterOffline ?? bundleOffline;
  const [cacheStamp, setCacheStamp] = useState<{ cached_at: string; count: number } | null>(null);
  const [cachedBundles, setCachedBundles] = useState<labelCache.CachedBundleSummary[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [displayed, setDisplayed] = useState<InitiativeAssetRow[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [settings, setSettings] = useState<PrintSettings>(() => readPrintSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cacheOpen, setCacheOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadStatus, setDownloadStatus] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const [inlineProgress, setInlineProgress] = useState<{ done: number; total: number } | null>(null);
  const [batch, setBatch] = useState<BatchPrintState | null>(null);
  const batchIdsRef = useRef<string[]>([]);
  const initiativeIdRef = useRef(initiativeId);
  initiativeIdRef.current = initiativeId;
  const labelTypeRef = useRef(labelType);
  labelTypeRef.current = labelType;
  const batchStaleRef = useRef(0);

  // Printer notices flow into the page's strip.
  useEffect(() => {
    if (printer.notice) {
      setNotice(printer.notice);
      printer.clearNotice();
    }
  }, [printer.notice]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshCachedBundles = useCallback(() => {
    void labelCache.listBundleSummaries().then(setCachedBundles);
  }, []);

  // ── initial loads (initiatives + vocab), with cache fallback ─────────
  useEffect(() => {
    listInitiatives()
      .then(setInitiatives)
      .catch(async () => {
        const cached = await labelCache.listInitiatives();
        setInitiatives(cached.map((c) => c.initiative));
        setRosterOffline((s) => s ?? (cached[0]?.cached_at ?? null));
        if (cached.length === 0) setNotice({ type: 'error', message: "Couldn't load initiatives." });
      });
    listLabelVocab().then(setVocab).catch(async () => {
      const cached = await labelCache.listBundleSummaries();
      if (cached.length === 0) setNotice({ type: 'error', message: "Couldn't load label types." });
    });
    refreshCachedBundles();
  }, [refreshCachedBundles]);

  const typeVocab = useMemo(
    () => vocabOfKind(vocab, 'type').filter((v) => !NOT_YET_PRINTABLE_TYPES.has(v.key)), [vocab]);
  // Offline without vocab: the types present in cached bundles.
  const typeChoices = useMemo(() => {
    if (typeVocab.length > 0) return typeVocab.map((v) => ({ key: v.key, label: v.label }));
    const keys = Array.from(new Set(cachedBundles.map((b) => b.label_type)));
    return keys.map((key) => ({ key, label: key }));
  }, [typeVocab, cachedBundles]);
  const typeLabel = (key: string) => (key === LABEL_TYPE_CUSTOM ? 'Custom' : (typeChoices.find((t) => t.key === key)?.label ?? vocabLabel(vocab, 'type', key)));

  const pickerOptions = useMemo(
    () => visibleInitiativesForGenerate(initiatives ?? []).map((i) => ({ value: i.id, label: i.name, sub: i.client_name ?? undefined })),
    [initiatives]);
  const initiative = useMemo(() => initiatives?.find((i) => i.id === initiativeId) ?? null, [initiatives, initiativeId]);

  // ── roster load (API → cache), clears selection like V2 ──────────────
  const loadRoster = useCallback(async (id: string, opts: { keepSelection?: boolean } = {}) => {
    setRosterLoading(true);
    if (!opts.keepSelection) setSelected([]);
    try {
      const rows = await listInitiativeAssets(id);
      if (initiativeIdRef.current !== id) return;
      setRoster(rows);
      if (opts.keepSelection) {
        setSelected((s) => s.filter((id) => rows.some((r) => r.asset_id === id)));
      }
      setRosterOffline(null);
      const item = initiatives?.find((i) => i.id === id);
      if (item) await labelCache.putInitiative({ initiative: item, roster: rows });
    } catch (err) {
      if (initiativeIdRef.current !== id) return;
      const cached = isNetworkFailure(err) ? await labelCache.getInitiative(id) : null;
      if (cached) {
        setRoster(cached.roster);
        setRosterOffline(cached.cached_at);
      } else {
        setRoster([]);
        setNotice({ type: 'error', message: "Couldn't load the initiative's assets." });
      }
    } finally {
      if (initiativeIdRef.current === id) setRosterLoading(false);
    }
  }, [initiatives]);

  useEffect(() => {
    if (!initiativeId) { setRoster(null); setSelected([]); setBundle(null); return; }
    void loadRoster(initiativeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initiativeId]);

  // ── bundle load for initiative + type (API → cache) ──────────────────
  const loadBundle = useCallback(async (id: string, type: string) => {
    setBundleLoading(true);
    try {
      const b = await getGeneratedLabelBundle(id, type);
      if (initiativeIdRef.current !== id || labelTypeRef.current !== type) return;
      setBundle(b);
      setBundleOffline(null);
      const name = initiatives?.find((i) => i.id === id)?.name ?? id;
      await labelCache.putBundle(b, name);
      setCacheStamp({ cached_at: new Date().toISOString(), count: b.labels.length });
      refreshCachedBundles();
    } catch (err) {
      if (initiativeIdRef.current !== id || labelTypeRef.current !== type) return;
      const cached = isNetworkFailure(err) ? await labelCache.getBundle(id, type) : null;
      if (cached) {
        setBundle(cached);
        setBundleOffline(cached.cached_at);
        setCacheStamp({ cached_at: cached.cached_at, count: cached.labels.length });
      } else {
        setBundle(null);
        setCacheStamp(null);
        setNotice({ type: 'error', message: `Couldn't load ${typeLabel(type)} labels.` });
      }
    } finally {
      if (initiativeIdRef.current === id && labelTypeRef.current === type) setBundleLoading(false);
    }
  }, [initiatives, refreshCachedBundles]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setBundle(null);
    setCacheStamp(null);
    setBundleOffline(null);
    setBundleLoading(!!initiativeId && !!labelType && labelType !== LABEL_TYPE_CUSTOM);
    if (!initiativeId || !labelType || labelType === LABEL_TYPE_CUSTOM) return;
    void loadBundle(initiativeId, labelType);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initiativeId, labelType]);

  // Default the type to the first choice once vocab arrives (V2 defaulted to Front).
  useEffect(() => {
    if (!labelType && typeChoices.length > 0) setLabelType(typeChoices[0].key);
  }, [typeChoices, labelType]);

  // Back online → refetch what's in view.
  useEffect(() => {
    const onOnline = () => {
      if (initiativeIdRef.current) {
        void loadRoster(initiativeIdRef.current, { keepSelection: true });
        if (labelType && labelType !== LABEL_TYPE_CUSTOM) void loadBundle(initiativeIdRef.current, labelType);
      }
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [labelType, loadRoster, loadBundle]);

  const byEntity = useMemo(() => bundleByEntity(bundle), [bundle]);
  const isCustom = labelType === LABEL_TYPE_CUSTOM;
  const statusOf = useCallback((r: InitiativeAssetRow): LabelStatus => labelStatusFor(r.asset_id, byEntity), [byEntity]);
  const coverage = useMemo(() => {
    if (!roster || isCustom || !labelType) return null;
    const have = roster.filter((r) => statusOf(r) === 'ready' || statusOf(r) === 'stale').length;
    return { have, total: roster.length, missing: roster.length - have };
  }, [roster, isCustom, labelType, statusOf]);

  const updateSettings = (next: PrintSettings) => { setSettings(next); writePrintSettings(next); };

  // ── sending ──────────────────────────────────────────────────────────
  const sendLabel = (zpl: string, singleCopy = false) => printer.send(applyPrintSettings(zpl, settings, { singleCopy }));
  const sendBlanks = async (count: number) => { if (count > 0) await sendLabel(blankLabelsZpl(count), true); };
  const zplFor = (assetId: string): string | null => (isCustom ? (customZpl.trim() || null) : (byEntity.get(assetId)?.code ?? null));
  const rowById = useMemo(() => new Map((roster ?? []).map((r) => [r.asset_id, r])), [roster]);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Send `ids[from..to)`; returns formats sent and blanks fed. */
  const sendRange = async (ids: string[], from: number, to: number, onSent?: (n: number) => void) => {
    let formatsSent = 0, blanksSent = 0, skipped = 0;
    let prevRack: string | null = from > 0 ? rackOf(rowById.get(ids[from - 1])) : null;
    for (const assetId of ids.slice(from, to)) {
      const zpl = zplFor(assetId);
      if (!zpl) { skipped += 1; continue; }
      const rack = rackOf(rowById.get(assetId));
      if (settings.printByRack && prevRack !== null && rack !== prevRack) {
        await sendBlanks(settings.blanksBetweenRacks);
        blanksSent += settings.blanksBetweenRacks;
      }
      await sendLabel(zpl);
      prevRack = rack;
      formatsSent += 1;
      onSent?.(formatsSent);
      await sleep(LABEL_DELAY_MS);
    }
    return { formatsSent, blanksSent, skipped };
  };

  const printableIds = useMemo(() => printOrder(selected, displayed, settings), [selected, displayed, settings]);

  const validateForPrint = (): { ids: string[]; stale: number } | null => {
    if (!printer.connected || !labelType || printableIds.length === 0) {
      setNotice({ type: 'error', message: 'Please connect a printer, select a label type, and select assets to print' });
      return null;
    }
    if (isCustom) {
      if (!customZpl.trim()) { setNotice({ type: 'error', message: 'Please enter raw ZPL code for custom label printing' }); return null; }
      return { ids: printableIds, stale: 0 };
    }
    const missing = missingLabelIds(printableIds, byEntity);
    if (missing.length > 0) {
      const unsupported = missing.filter((id) => labelStatusFor(id, byEntity) === 'unsupported').length;
      setNotice({
        type: 'error',
        message: unsupported === missing.length
          ? `${missing.length} selected asset(s) have labels compiled for a non-Zebra printer`
          : `${missing.length} selected asset(s) do not have ${typeLabel(labelType)} data. Please generate labels first.`,
        action: { label: 'Deselect missing', onClick: () => { setSelected((s) => s.filter((id) => !missing.includes(id))); setNotice(null); } },
      });
      return null;
    }
    const stale = staleLabelCount(printableIds, byEntity);
    return { ids: printableIds, stale };
  };

  const printBatch = async (batchNumber: number, ids: string[]) => {
    const { start, end } = batchBounds(batchNumber, settings.batchSize, ids.length);
    setBatch((b) => b && { ...b, currentBatch: batchNumber, printing: true, finishing: false, batchComplete: false, error: null });
    try {
      const { formatsSent, blanksSent } = await sendRange(ids, start, end);
      setBatch((b) => b && { ...b, finishing: true });
      await printer.waitForIdle((end - start) * (settings.copies || 1) + blanksSent, (queued) => {
        const printedThisBatch = Math.max(0, Math.min(formatsSent - queued, formatsSent));
        setBatch((b) => b && { ...b, printedCount: Math.min(start + printedThisBatch, end) });
      });
      const allDone = end >= ids.length;
      setBatch((b) => b && { ...b, printedCount: end, finishing: false, printing: false, batchComplete: true, allComplete: allDone });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Print failed';
      setBatch((b) => b && { ...b, printing: false, finishing: false, batchComplete: true, error: `Batch ${batchNumber} failed: ${message}` });
    }
  };

  const handlePrint = async () => {
    const result = validateForPrint();
    if (!result) return;
    const { ids, stale } = result;
    if (ids.length > settings.batchSize) {
      batchIdsRef.current = ids;
      batchStaleRef.current = stale;
      setBatch({
        total: ids.length, batchSize: settings.batchSize, currentBatch: 1, totalBatches: batchCount(ids.length, settings.batchSize),
        printedCount: 0, printing: true, finishing: false, batchComplete: false, allComplete: false,
        autoPrintNext: false, autoCountdown: null, error: null,
      });
      await printBatch(1, ids);
      return;
    }
    setPrinting(true);
    setInlineProgress({ done: 0, total: ids.length });
    setNotice({ type: 'info', message: `Printing ${ids.length} label(s)...` });
    try {
      const { formatsSent, skipped } = await sendRange(ids, 0, ids.length, (n) => setInlineProgress({ done: n, total: ids.length }));
      const staleSuffix = stale > 0 ? `. ${stale} used an older template — regenerate for the latest layout.` : '';
      setNotice(skipped > 0
        ? { type: 'warning', message: `Printed ${formatsSent} label(s), skipped ${skipped} (no label data)` }
        : { type: 'success', message: `Successfully printed ${ids.length} label(s)${staleSuffix}` });
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Print failed' });
    } finally {
      setPrinting(false);
      setInlineProgress(null);
    }
  };

  const printNextBatch = () => {
    const next = (batch?.currentBatch ?? 0) + 1;
    setBatch((b) => b && { ...b, autoCountdown: null });
    void printBatch(next, batchIdsRef.current);
  };
  const reprintBatch = () => { if (batch) void printBatch(batch.currentBatch, batchIdsRef.current); };
  const closeBatch = () => {
    if (batch?.allComplete) {
      const stale = batchStaleRef.current;
      const staleSuffix = stale > 0 ? `. ${stale} used an older template — regenerate for the latest layout.` : '';
      setNotice({ type: 'success', message: `Successfully printed ${batch.total} label(s)${staleSuffix}` });
    }
    setBatch(null);
  };

  // Auto-next countdown (V2): starts when a batch completes with the toggle on.
  useEffect(() => {
    if (!batch) return;
    const shouldCount = batch.batchComplete && !batch.allComplete && batch.autoPrintNext && !batch.printing && !batch.error;
    if (shouldCount && batch.autoCountdown === null) setBatch((b) => b && { ...b, autoCountdown: AUTO_NEXT_SECONDS });
    if (!shouldCount && batch.autoCountdown !== null) setBatch((b) => b && { ...b, autoCountdown: null });
  }, [batch?.batchComplete, batch?.allComplete, batch?.autoPrintNext, batch?.printing, batch?.error]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!batch || batch.autoCountdown === null) return undefined;
    if (batch.autoCountdown <= 0) { printNextBatch(); return undefined; }
    const timer = setTimeout(() => setBatch((b) => b && b.autoCountdown !== null ? { ...b, autoCountdown: b.autoCountdown - 1 } : b), 1000);
    return () => clearTimeout(timer);
  }, [batch?.autoCountdown]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── offline cache modal actions ──────────────────────────────────────
  const downloadForOffline = async (types: string[]) => {
    if (!initiative) return;
    setDownloading(true);
    setDownloadStatus(null);
    try {
      const rows = await listInitiativeAssets(initiative.id);
      await labelCache.putInitiative({ initiative, roster: rows });
      let labels = 0;
      for (const t of types) {
        const b = await getGeneratedLabelBundle(initiative.id, t);
        await labelCache.putBundle(b, initiative.name);
        labels += b.labels.length;
      }
      setDownloadStatus(`Cached ${types.length} types · ${labels} labels`);
      refreshCachedBundles();
    } catch (err) {
      setDownloadStatus(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  };

  const printAlignmentTest = async (zpl: string, sizeLabel: string) => {
    try {
      await sendLabel(zpl, true);
      setNotice({ type: 'success', message: `Alignment test label (${sizeLabel}) sent to printer` });
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Failed to print alignment test label' });
    }
  };

  const canPrint = printer.connected && !!labelType && printableIds.length > 0 && !printing && !batch;
  const modified = settingsModified(settings);

  return (
    <div className="portal-page plabels-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Labels</div>
          <h1 className="page-title">Print Labels</h1>
          <p className="page-hint">
            Select an initiative and label type, connect a Zebra printer over USB, and print labels for the assets you choose.
          </p>
        </div>
        <div className="plabels-head-actions">
          <button type="button" className="btn-ghost" onClick={() => setCacheOpen(true)}>
            Offline cache{cachedBundles.length > 0 ? ` · ${cachedBundles.length} cached` : ''}
          </button>
          <button type="button" className="btn-ghost plabels-gear" aria-label="Print settings" title="Print settings"
                  onClick={() => setSettingsOpen(true)}>
            Settings{modified && <span className="plabels-modified" aria-hidden="true" />}
          </button>
        </div>
      </div>

      {offlineSince && (
        <div className="plabels-notice warning">
          <p className="page-hint">
            Offline — using labels downloaded {relativeTime(offlineSince)}. Printing works; changes made elsewhere are not reflected.
          </p>
        </div>
      )}
      {notice && (
        <div className={`plabels-notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>
          <p className="page-hint">{notice.message}</p>
          <div className="plabels-notice-actions">
            {notice.action && <button type="button" className="mini-btn" onClick={notice.action.onClick}>{notice.action.label}</button>}
            <button type="button" className="mini-btn" onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
          </div>
        </div>
      )}

      <div className="plabels-steps">
        <StepCard step="Step 1" title="Initiative" hint="Pick the initiative whose assets you are labeling.">
          <ComboBox options={pickerOptions} value={initiativeId} onChange={(v) => { setInitiativeId(v); setNotice(null); }}
                    placeholder="Choose an initiative…" clearable />
          {initiatives && !initiative && (
            <p className="page-hint">{offlineSince ? 'Showing cached initiatives.' : `${pickerOptions.length} active initiatives available`}</p>
          )}
          {initiative && (
            <div>
              <InitiativeSummary initiative={summaryFromInitiative(initiative)} emptyText="" />
              <div className="plabels-summary-line">
                <span className="cell-sub">{rosterLoading ? 'Loading assets…' : `${roster?.length ?? 0} assets`}</span>
                {cacheStamp && !isCustom && (
                  <span className="chip tag">Cached for offline · {cacheStamp.count} labels · {relativeTime(cacheStamp.cached_at)}</span>
                )}
                {!cacheStamp && labelType && !isCustom && !bundleLoading && (
                  <span className="chip tag">Not cached</span>
                )}
              </div>
            </div>
          )}
        </StepCard>

        <StepCard step="Step 2" title="Label type" hint="Choose the type of label to print.">
          <div className="rgm-choice-cards" role="radiogroup" aria-label="Label type">
            {typeChoices.map((t) => (
              <ChoiceCard key={t.key} title={t.label} selected={labelType === t.key} onSelect={() => setLabelType(t.key)}
                          description={labelType === t.key && coverage
                            ? `${coverage.have} of ${coverage.total} assets have a ${t.label}${coverage.missing > 0 ? ` · ${coverage.missing} missing` : ''}`
                            : `Printable ${t.label.toLowerCase()} for each selected asset`} />
            ))}
            <ChoiceCard title="Custom" selected={isCustom} onSelect={() => setLabelType(LABEL_TYPE_CUSTOM)}
                        description="Send raw ZPL to the printer once per selected asset" />
          </div>
          {coverage && coverage.missing > 0 && (
            <p className="page-hint"><Link to="/labels/generate">Generate labels</Link> for the assets that are missing one.</p>
          )}
          {isCustom && (
            <div className="pf-form">
              <div>
                <label htmlFor="plabels-zpl">Raw ZPL</label>
                <textarea id="plabels-zpl" className="plabels-zpl mono" rows={6} value={customZpl}
                          placeholder={'^XA\n^FO50,50^ADN,36,20^FDHello World^FS\n^XZ'}
                          onChange={(e) => setCustomZpl(e.target.value)} />
                <p className="page-hint">Enter raw ZPL code to send directly to the printer</p>
              </div>
            </div>
          )}
        </StepCard>

        <StepCard step="Step 3" title="Printer" hint="A Zebra printer connected to this computer over USB.">
          <div className="plabels-printer-status">
            <span className={`dot ${printer.connected ? 'on' : 'off'}`} />
            <span className="cell-top">
              {printer.connected ? `Printer connected${printer.productName ? ` · ${printer.productName}` : ''}` : 'No printer connected'}
            </span>
          </div>
          {!printer.supported ? (
            <p className="page-hint">USB printing needs Chrome or Edge on a secure (https or localhost) address.</p>
          ) : printer.connected ? (
            <button type="button" className="btn-ghost" onClick={() => void printer.disconnect()}>Disconnect</button>
          ) : (
            <button type="button" className="btn-solid" onClick={() => void printer.connect()}>Connect via USB</button>
          )}
          <p className="page-hint">Requires a Zebra printer connected via USB. Make sure the printer is turned on before connecting.</p>
        </StepCard>
      </div>

      <div className="plabels-card">
        <div className="plabels-card-head">
          <div>
            <span className="eyebrow">Step 4</span>
            <div className="modal-section">Assets to print</div>
          </div>
        </div>
        {!initiativeId ? (
          <div className="dir-empty">Select an initiative to view assets</div>
        ) : rosterLoading && !roster ? (
          <div className="dir-empty">Loading assets…</div>
        ) : roster && roster.length === 0 ? (
          <div className="dir-empty">No assets found on this initiative</div>
        ) : roster ? (
          <PrintAssetList rows={roster} statusOf={isCustom || !labelType ? null : statusOf} selected={selected}
                          onSelectedChange={setSelected} onDisplayedChange={setDisplayed}
                          onRefresh={() => void loadRoster(initiativeId, { keepSelection: true })} refreshing={rosterLoading}
                          disabled={printing || !!batch} resetKey={initiativeId} />
        ) : null}
      </div>

      <div className="plabels-card plabels-ready">
        <div className="plabels-ready-text">
          <div className="modal-section">Ready to print</div>
          <span className="cell-sub">
            {inlineProgress
              ? `Printing ${inlineProgress.done} of ${inlineProgress.total}…`
              : selected.length === 0 ? 'Select assets to print labels'
              : `${printableIds.length} label(s) will be printed${selected.length > printableIds.length ? ` · ${selected.length - printableIds.length} selected asset(s) are hidden by the current filters` : ''}`}
          </span>
        </div>
        <div className="plabels-ready-actions">
          <div className="plabels-ready-chips">
            <span className={`chip ${initiativeId ? 'c-green' : 'c-slate'}`}>{initiativeId ? 'Initiative selected' : 'No initiative'}</span>
            <span className={`chip ${labelType ? 'c-green' : 'c-slate'}`}>{labelType ? typeLabel(labelType) : 'No label type'}</span>
            <span className={`chip ${printer.connected ? 'c-green' : 'c-slate'}`}>{printer.connected ? 'Printer ready' : 'No printer'}</span>
          </div>
          <button type="button" className="btn-ghost plabels-gear" aria-label="Print settings" title="Print settings"
                  onClick={() => setSettingsOpen(true)}>
            Settings{modified && <span className="plabels-modified" aria-hidden="true" />}
          </button>
          <button type="button" className="btn-solid" disabled={!canPrint} onClick={() => void handlePrint()}>
            {printing ? 'Printing…' : `Print ${printableIds.length} label${printableIds.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>

      {settingsOpen && (
        <PrintSettingsModal settings={settings} onChange={updateSettings} vocab={vocab}
                            printerConnected={printer.connected} onPrintAlignmentTest={printAlignmentTest}
                            onClose={() => setSettingsOpen(false)} />
      )}
      {batch && (
        <PrintBatchModal state={batch}
                         subtitle={`${initiative?.name ?? ''} · ${typeLabel(labelType)} · ${batch.total} labels in ${batch.totalBatches} batches of ${batch.batchSize}`}
                         onAutoPrintNextChange={(v) => setBatch((b) => b && { ...b, autoPrintNext: v })}
                         onPrintNext={printNextBatch} onReprint={reprintBatch} onCancel={closeBatch} onDone={closeBatch} />
      )}
      {cacheOpen && (
        <OfflineCacheModal bundles={cachedBundles}
                           selectedInitiative={initiative ? { id: initiative.id, name: initiative.name } : null}
                           labelTypes={typeChoices} downloading={downloading} downloadStatus={downloadStatus}
                           onDownload={downloadForOffline}
                           onRemove={async (i, t) => {
                             await labelCache.deleteBundle(i, t);
                             refreshCachedBundles();
                             if (i === initiativeId && t === labelType) setCacheStamp(null);
                           }}
                           onClearAll={async () => { await labelCache.clearAll(); refreshCachedBundles(); setCacheStamp(null); }}
                           onClose={() => { setCacheOpen(false); setDownloadStatus(null); }} />
      )}
    </div>
  );
}
