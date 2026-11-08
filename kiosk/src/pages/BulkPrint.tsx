/**
 * Label Printing › Bulk Print — the portal's Print Labels page
 * (`portal/src/pages/PrintLabels.tsx`) on the kiosk, for the move in
 * Kiosk Setup: pick a label type, pick assets (or containers), print on
 * the printer saved in Printer Setup. Spec:
 * docs/superpowers/specs/2026-11-07-kiosk-bulk-print-design.md.
 *
 * Where the portal page has an Initiative step and a Printer step, this
 * page has neither: the move is Kiosk Setup's and the printer is the
 * Label Station's (`useStationPrinter`), named in the Ready to print card.
 * Only labels at the saved printer's DPI count; with no saved printer the
 * list's DPI column says which DPIs each row has.
 *
 * - **Rows** come from the move data synced to this kiosk (the `assets`
 *   and `containers` stores, adapted to the portal's shapes), read on
 *   open, after a sync and when the move changes. Rows synced for another
 *   move are never listed: the stores may still hold the previous move
 *   while a new move's sync runs, or after it failed.
 * - **Labels** come from `GET /kiosk/labels/bundle` through the kiosk's
 *   write-through cache (`bundleCache.ts`): offline, the last copy serves
 *   and the portal's offline notice says how old it is. A result for a
 *   move or type the page has since left is dropped.
 * - **Label types** are the label vocabulary less the person types, plus
 *   Custom. Offline with no stored vocab, the move's cached bundles' types.
 *
 * Two modes, as in the portal: asset label types list the move's assets,
 * container types its containers, each with its own selection and shown
 * rows. A type's `default_copies` seeds copies without ever being saved.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type { ContainerItem, InitiativeAssetRow } from '@portal/lib/api';
import { relativeTime } from '@portal/lib/format';
import { isContainerLabelType, isPersonLabelType, vocabLabel, vocabOfKind } from '@portal/lib/labels';
import {
  LABEL_TYPE_CUSTOM, bundleAtDpi, bundleByEntity, containerPrintOrder, defaultCopiesFor,
  dpisByEntity, labelStatusFor, printOrder, readPrintSettings,
  type LabelStatus, type PrintSettings,
} from '@portal/lib/printLabels';
import PrintAssetList from '@portal/components/labels/PrintAssetList';
import PrintContainerList from '@portal/components/labels/PrintContainerList';
import '@portal/styles/labels.css';
import '@portal/styles/dashboard.css';

import { useKioskAuth } from '../auth/KioskAuthContext';
import BulkPrintSettingsModal from '../components/labels/BulkPrintSettingsModal';
import { ChoiceCard } from '../components/printers/ChoiceCard';
import type {
  GeneratedLabelBundle, KioskAssetRow, KioskContainerRow, LabelVocab,
} from '../lib/api';
import { cachedBundleTypes, loadBundle, loadVocab } from '../lib/bundleCache';
import { toPrintAssetRow, toPrintContainerItem } from '../lib/bulkPrintRows';
import { bulkSettingsModified, writeBulkSettings } from '../lib/bulkPrintSettings';
import { useKioskSetup } from '../lib/kioskSetup';
import { labelBackend } from '../lib/labelBackend';
import { LABEL_SECTIONS, type PrinterSetupRouteState } from '../lib/labelSections';
import { KioskListPrefsProvider } from '../lib/listPrefs';
import { getAll, readMeta } from '../lib/localDb';
import { useSyncStatus } from '../lib/sync';
import { useStationPrinter } from '../lib/useStationPrinter';

/** The id of Custom's one send when no row is ticked (no row has it). */
const RAW_ONCE = '';

const BULK_PATH = LABEL_SECTIONS.find((s) => s.id === 'bulk')!.path;
const PRINTER_SETUP_PATH = LABEL_SECTIONS.find((s) => s.id === 'printers')!.path;
/** Printer Setup, opened from here: its Finish and Back come back here. */
const TO_PRINTER_SETUP: PrinterSetupRouteState = { returnTo: BULK_PATH };

interface Notice { type: 'success' | 'info' | 'warning' | 'error'; message: string; action?: { label: string; onClick: () => void } }

/** What the synced stores hold for the set-up move. */
type RowsState = 'loading' | 'ready' | 'not_this_move' | 'error';

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

export default function BulkPrint() {
  // The edge on a laptop, this kiosk's own store on the web; the platform
  // never changes while the page is up.
  const web = labelBackend().kind === 'web';
  const [setup] = useKioskSetup();
  const initiativeId = setup?.initiativeId ?? '';
  const { phase } = useSyncStatus();
  const station = useStationPrinter();
  const { preferences } = useKioskAuth();

  const [vocab, setVocab] = useState<LabelVocab[]>([]);
  const [vocabLoaded, setVocabLoaded] = useState(false);
  /** The move's cached bundle types, for the type list offline with no vocab. */
  const [cachedTypes, setCachedTypes] = useState<{ initiativeId: string; types: string[] } | null>(null);
  const [labelType, setLabelType] = useState('');
  const [customZpl, setCustomZpl] = useState('');
  const [roster, setRoster] = useState<InitiativeAssetRow[] | null>(null);
  const [containers, setContainers] = useState<ContainerItem[] | null>(null);
  const [rowsState, setRowsState] = useState<RowsState>('loading');
  const [rowsLoading, setRowsLoading] = useState(false);
  const [bundle, setBundle] = useState<GeneratedLabelBundle | null>(null);
  const [bundleLoading, setBundleLoading] = useState(false);
  /** cached_at of the bundle being served offline; null online. */
  const [offlineSince, setOfflineSince] = useState<string | null>(null);
  const [cacheStamp, setCacheStamp] = useState<{ cached_at: string; count: number } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [displayed, setDisplayed] = useState<InitiativeAssetRow[]>([]);
  const [containerSelected, setContainerSelected] = useState<string[]>([]);
  const [containerDisplayed, setContainerDisplayed] = useState<ContainerItem[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  // The operator's own print settings — the only thing ever written back.
  // A label type's `default_copies` seed lives beside it, so a seed can
  // never be saved over a value the operator chose (the portal's rule).
  const [operatorSettings, setOperatorSettings] = useState<PrintSettings>(() => readPrintSettings());
  const [seededCopies, setSeededCopies] = useState<number | null>(null);
  const settings = useMemo<PrintSettings>(
    () => (seededCopies === null ? operatorSettings : { ...operatorSettings, copies: seededCopies }),
    [operatorSettings, seededCopies]);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const initiativeIdRef = useRef(initiativeId);
  initiativeIdRef.current = initiativeId;
  const labelTypeRef = useRef(labelType);
  labelTypeRef.current = labelType;
  const rowsLoadId = useRef(0);
  const typesNoticeShown = useRef(false);

  // ── label types: the vocab (stored copy offline), else cached bundles ──
  useEffect(() => {
    let alive = true;
    loadVocab()
      .then(({ vocab: rows }) => rows, () => [] as LabelVocab[])
      .then((rows) => {
        if (!alive) return;
        setVocab(rows);
        setVocabLoaded(true);
      });
    return () => { alive = false; };
  }, []);

  const refreshCachedTypes = useCallback((id: string) => {
    if (!id) return;
    cachedBundleTypes(id)
      .catch(() => [] as string[])
      .then((types) => {
        if (initiativeIdRef.current === id) setCachedTypes({ initiativeId: id, types });
      });
  }, []);

  useEffect(() => { refreshCachedTypes(initiativeId); }, [initiativeId, refreshCachedTypes]);

  // an ID badge has no generated labels: it prints from the label builder
  const typeVocab = useMemo(() => vocabOfKind(vocab, 'type').filter((v) => !isPersonLabelType(v.key)), [vocab]);
  const typeChoices = useMemo(() => {
    if (typeVocab.length > 0) return typeVocab.map((v) => ({ key: v.key, label: v.label }));
    const keys = cachedTypes?.initiativeId === initiativeId ? cachedTypes.types : [];
    return keys.map((key) => ({ key, label: key }));
  }, [typeVocab, cachedTypes, initiativeId]);
  const typeLabel = (key: string) => (key === LABEL_TYPE_CUSTOM ? 'Custom' : (typeChoices.find((t) => t.key === key)?.label ?? vocabLabel(vocab, 'type', key)));

  // No vocab and no cached bundle to name a type: say so, once.
  useEffect(() => {
    if (typesNoticeShown.current || !vocabLoaded || typeVocab.length > 0) return;
    if (!initiativeId || cachedTypes?.initiativeId !== initiativeId || cachedTypes.types.length > 0) return;
    typesNoticeShown.current = true;
    setNotice({ type: 'error', message: "Couldn't load label types." });
  }, [vocabLoaded, typeVocab, cachedTypes, initiativeId]);

  /** Seeds copies from the new type's default_copies, or clears the seed
   *  for a type with none so the operator's own value comes back. Never
   *  saved. Only an actual type change runs this (the portal's rule). */
  const handleLabelTypeChange = (key: string) => {
    if (key === labelType) return;
    setLabelType(key);
    setSeededCopies(defaultCopiesFor(vocab, key));
  };

  // The first choice, once the choices arrive.
  useEffect(() => {
    if (!labelType && typeChoices.length > 0) handleLabelTypeChange(typeChoices[0].key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeChoices, labelType]);

  // ── rows: the move data synced to this kiosk ─────────────────────────
  /** Reads the stores; lists them only when the sync was for this move.
   *  The selections keep the rows that are still there. */
  const loadRows = useCallback(async () => {
    const id = initiativeIdRef.current;
    const mine = ++rowsLoadId.current;
    const live = () => mine === rowsLoadId.current;
    if (!id) return;
    setRowsLoading(true);
    try {
      const [assets, crates, meta] = await Promise.all([
        getAll<KioskAssetRow>('assets'), getAll<KioskContainerRow>('containers'), readMeta('sync'),
      ]);
      if (!live()) return;
      if (meta?.initiativeId !== id) {
        setRoster(null);
        setContainers(null);
        setSelected([]);
        setDisplayed([]);
        setContainerSelected([]);
        setContainerDisplayed([]);
        setRowsState('not_this_move');
        return;
      }
      const rows = assets.map(toPrintAssetRow);
      const items = crates.map(toPrintContainerItem);
      setRoster(rows);
      setContainers(items);
      setSelected((s) => s.filter((sid) => rows.some((r) => r.asset_id === sid)));
      setContainerSelected((s) => s.filter((cid) => items.some((c) => c.id === cid)));
      setRowsState('ready');
    } catch {
      if (live()) setRowsState('error');
    } finally {
      if (live()) setRowsLoading(false);
    }
  }, []);

  // A move change starts both lists over.
  useEffect(() => {
    setRoster(null);
    setContainers(null);
    setSelected([]);
    setDisplayed([]);
    setContainerSelected([]);
    setContainerDisplayed([]);
    setRowsState('loading');
    void loadRows();
  }, [initiativeId, loadRows]);

  // Again whenever a sync finishes (the mount's read is the effect above).
  const firstPhase = useRef(true);
  useEffect(() => {
    if (firstPhase.current) { firstPhase.current = false; return; }
    if (phase === 'done' || phase === 'idle') void loadRows();
  }, [phase, loadRows]);

  // ── labels for the move + type (API → cache) ─────────────────────────
  const loadBundleFor = async (id: string, type: string) => {
    setBundleLoading(true);
    try {
      const { bundle: b, offlineSince: since } = await loadBundle(id, type);
      if (initiativeIdRef.current !== id || labelTypeRef.current !== type) return;
      setBundle(b);
      setOfflineSince(since);
      setCacheStamp({ cached_at: since ?? new Date().toISOString(), count: b.labels.length });
      refreshCachedTypes(id);
    } catch {
      if (initiativeIdRef.current !== id || labelTypeRef.current !== type) return;
      setBundle(null);
      setOfflineSince(null);
      setCacheStamp(null);
      setNotice({
        type: 'error',
        message: `Couldn't load ${typeLabel(type)} labels.`,
        // Retry loads these labels only while they are still in view: a
        // load for a move or type already left would be dropped anyway.
        action: {
          label: 'Retry',
          onClick: () => {
            setNotice(null);
            if (initiativeIdRef.current === id && labelTypeRef.current === type) void loadBundleRef.current(id, type);
          },
        },
      });
    } finally {
      if (initiativeIdRef.current === id && labelTypeRef.current === type) setBundleLoading(false);
    }
  };
  const loadBundleRef = useRef(loadBundleFor);
  loadBundleRef.current = loadBundleFor;

  useEffect(() => {
    setBundle(null);
    setCacheStamp(null);
    setOfflineSince(null);
    const wanted = !!initiativeId && !!labelType && labelType !== LABEL_TYPE_CUSTOM;
    setBundleLoading(wanted);
    if (wanted) void loadBundleRef.current(initiativeId, labelType);
  }, [initiativeId, labelType]);

  // Back online → load the labels in view again.
  useEffect(() => {
    const onOnline = () => {
      const id = initiativeIdRef.current;
      const type = labelTypeRef.current;
      if (id && type && type !== LABEL_TYPE_CUSTOM) void loadBundleRef.current(id, type);
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);

  // ── what the list shows ──────────────────────────────────────────────
  /** The saved printer's DPI; only its labels print. */
  const printerDpi = station.settings ? String(station.settings.dpi) : null;
  const containerMode = isContainerLabelType(labelType);
  const isCustom = labelType === LABEL_TYPE_CUSTOM;
  const byEntity = useMemo(() => bundleByEntity(bundleAtDpi(bundle, printerDpi)), [bundle, printerDpi]);
  // With no saved printer each row may have labels at several DPIs: the
  // lists' DPI column names them.
  const dpiMap = useMemo(() => (printerDpi ? null : dpisByEntity(bundle)), [bundle, printerDpi]);
  const assetDpis = useMemo(
    () => (dpiMap ? (r: InitiativeAssetRow) => dpiMap.get(r.asset_id) ?? [] : null), [dpiMap]);
  const containerDpis = useMemo(
    () => (dpiMap ? (c: ContainerItem) => dpiMap.get(c.id) ?? [] : null), [dpiMap]);
  const statusOf = useCallback((r: InitiativeAssetRow): LabelStatus => labelStatusFor(r.asset_id, byEntity, printerDpi), [byEntity, printerDpi]);
  const containerStatusOf = useCallback((c: ContainerItem): LabelStatus => labelStatusFor(c.id, byEntity, printerDpi), [byEntity, printerDpi]);
  const entityNoun = containerMode ? 'container' : 'asset';
  const liveContainers = useMemo(() => (containers ?? []).filter((c) => !c.archived_at), [containers]);
  /** What the "Cached for offline" chip counts: the labels of rows the
   *  list can show (a container bundle may cover archived containers). */
  const cachedLabelCount = useMemo(() => {
    if (!cacheStamp) return 0;
    if (!containerMode || !containers) return cacheStamp.count;
    return liveContainers.filter((c) => byEntity.has(c.id)).length;
  }, [cacheStamp, containerMode, containers, liveContainers, byEntity]);
  const coverage = useMemo(() => {
    if (isCustom || !labelType) return null;
    if (containerMode) {
      if (!containers) return null;
      const have = liveContainers.filter((c) => ['ready', 'stale'].includes(containerStatusOf(c))).length;
      return { have, total: liveContainers.length, missing: liveContainers.length - have };
    }
    if (!roster) return null;
    const have = roster.filter((r) => statusOf(r) === 'ready' || statusOf(r) === 'stale').length;
    return { have, total: roster.length, missing: roster.length - have };
  }, [roster, isCustom, labelType, statusOf, containerMode, containers, liveContainers, containerStatusOf]);

  /** The portal's rule: a `copies` that differs from what was on screen
   *  (or a Reset) is the operator claiming that number, so the seed goes
   *  and it is saved; any other change keeps the seed and the stored copies. */
  const updateSettings = (next: PrintSettings) => {
    const tookCopies = next.copies !== settings.copies || !bulkSettingsModified(next);
    if (tookCopies) setSeededCopies(null);
    const persisted = tookCopies ? next : { ...next, copies: operatorSettings.copies };
    setOperatorSettings(persisted);
    writeBulkSettings(persisted);
  };

  const printableIds = useMemo(
    () => (containerMode
      ? containerPrintOrder(containerSelected, containerDisplayed, settings)
      : printOrder(selected, displayed, settings)),
    [containerMode, containerSelected, containerDisplayed, selected, displayed, settings]);
  const activeSelected = containerMode ? containerSelected : selected;
  /** What Print sends: the printable selection, or for Custom with nothing
   *  ticked one send of the raw ZPL with no row behind it. */
  const printIds = useMemo(() => (isCustom && activeSelected.length === 0 ? [RAW_ONCE] : printableIds),
    [isCustom, activeSelected.length, printableIds]);
  const canPrint = station.state === 'ready' && !!station.printer && !!labelType && printIds.length > 0
    && (isCustom || !!printerDpi);
  const modified = bulkSettingsModified(settings);
  const readyHint = activeSelected.length === 0
    ? (isCustom ? `The ZPL prints once; select ${entityNoun}s to print it once per ${entityNoun}` : `Select ${entityNoun}s to print labels`)
    : `${printableIds.length} label(s) will be printed${activeSelected.length > printableIds.length ? ` · ${activeSelected.length - printableIds.length} selected ${entityNoun}(s) are hidden by the current filters` : ''}`;

  const head = (
    <div>
      <div className="eyebrow">Kiosk · Label Printing</div>
      <h1 className="page-title">Bulk Print</h1>
      <p className="page-hint">{setup ? `${setup.initiativeName} · ${setup.siteName}` : 'Finish Kiosk Setup first.'}</p>
    </div>
  );
  if (!setup) {
    return <div className="portal-page plabels-page bulk-print"><div className="dir-head">{head}</div></div>;
  }

  const saved = station.settings;
  const printerLine = saved
    ? `Printer: ${saved.printer.type === 'network' ? saved.printer.ip : (saved.printer.model ?? 'USB printer')} · ${saved.dpi} DPI`
    : '';
  const noRowsText = phase === 'running' ? 'Downloading move data…' : 'No move data on this kiosk. Sync it from Kiosk Setup.';

  return (
    <div className="portal-page plabels-page bulk-print">
      <div className="dir-head">
        {head}
        <div className="plabels-head-actions">
          <button type="button" className="btn-ghost plabels-gear" aria-label="Print settings" title="Print settings"
                  onClick={() => setSettingsOpen(true)}>
            Settings{modified && <span className="plabels-modified" aria-hidden="true" />}
          </button>
        </div>
      </div>

      <div className="plabels-summary-line">
        {(roster || rowsLoading) && (
          <span className="cell-sub">
            {containerMode
              ? (rowsLoading && !containers ? 'Loading containers…' : `${liveContainers.length} containers`)
              : (rowsLoading && !roster ? 'Loading assets…' : `${roster?.length ?? 0} assets`)}
          </span>
        )}
        {cacheStamp && !isCustom && (
          <span className="chip tag">Cached for offline · {cachedLabelCount} labels · {relativeTime(cacheStamp.cached_at)}</span>
        )}
        {!cacheStamp && labelType && !isCustom && !bundleLoading && (
          <span className="chip tag">Not cached</span>
        )}
      </div>

      {offlineSince && (
        <div className="plabels-notice warning">
          <p className="page-hint">
            {`Offline — using labels downloaded ${relativeTime(offlineSince)}. Printing works; changes made elsewhere are not reflected.`}
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
        <StepCard step="Step 1" title="Label type" hint="Choose the type of label to print.">
          <div className="rgm-choice-cards" role="radiogroup" aria-label="Label type">
            {typeChoices.map((t) => {
              const noun = isContainerLabelType(t.key) ? 'container' : 'asset';
              return (
                <ChoiceCard key={t.key} title={t.label} selected={labelType === t.key} onSelect={() => handleLabelTypeChange(t.key)}
                            description={labelType === t.key && coverage
                              ? `${coverage.have} of ${coverage.total} ${noun}s have a ${t.label}${coverage.missing > 0 ? ` · ${coverage.missing} missing` : ''}`
                              : `Printable ${t.label.toLowerCase()} for each selected ${noun}`} />
              );
            })}
            <ChoiceCard title="Custom" selected={isCustom} onSelect={() => handleLabelTypeChange(LABEL_TYPE_CUSTOM)}
                        description="Send raw ZPL to the printer once, or once per selected asset" />
          </div>
          {coverage && coverage.missing > 0 && (
            <p className="page-hint">Generate labels in the portal for the {entityNoun}s that are missing one.</p>
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

        <StepCard step="Step 3" title="Ready to print">
          {station.state === 'ready' && saved && (
            <>
              <div className="plabels-printer-status">
                <span className="dot on" />
                <span className="cell-top">{printerLine}</span>
              </div>
              <p className="page-hint"><Link to={PRINTER_SETUP_PATH} state={TO_PRINTER_SETUP}>Printer Setup</Link></p>
            </>
          )}
          {station.state === 'loading' && <p className="page-hint">Connecting to the label printer…</p>}
          {station.state === 'needs_usb' && (
            <div className="station-printer-note" role="status">
              <p>The label printer isn&apos;t connected. Connect it to start printing.</p>
              <button type="button" className="mini-btn" onClick={() => { void station.connectUsb(); }}>
                Connect printer
              </button>
            </div>
          )}
          {station.state === 'no_settings' && (
            <div className="station-printer-note" role="status">
              {web ? (
                <p>
                  No printer is set up on this kiosk. Set one up in
                  {' '}<Link to={PRINTER_SETUP_PATH} state={TO_PRINTER_SETUP}>Printer Setup</Link>.
                </p>
              ) : (
                <p>
                  This laptop isn&apos;t set up to print labels. Make it a Label Station in
                  {' '}<Link to="/setup">Kiosk Setup</Link> to print here.
                </p>
              )}
            </div>
          )}
          <p className="page-hint">{readyHint}</p>
          <div className="plabels-ready-actions">
            <button type="button" className="btn-solid" disabled={!canPrint}>
              {`Print ${printIds.length} label${printIds.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </StepCard>
      </div>

      <div className="plabels-card">
        <div className="plabels-card-head">
          <div>
            <span className="eyebrow">Step 2</span>
            <div className="modal-section">{containerMode ? 'Containers to print' : 'Assets to print'}</div>
          </div>
        </div>
        <KioskListPrefsProvider listSize={preferences?.list_size}>
          {rowsState === 'error' ? (
            <p className="form-error" role="alert">Couldn&apos;t read this kiosk&apos;s local data.</p>
          ) : rowsState === 'loading' ? (
            <div className="dir-empty">{containerMode ? 'Loading containers…' : 'Loading assets…'}</div>
          ) : rowsState === 'not_this_move' || !roster || !containers ? (
            <div className="dir-empty">{noRowsText}</div>
          ) : containerMode ? (
            liveContainers.length === 0 ? (
              <div className="dir-empty">No containers found on this move</div>
            ) : (
              <PrintContainerList rows={containers} statusOf={isCustom || !labelType ? null : containerStatusOf}
                                  dpisOf={isCustom || !labelType ? null : containerDpis}
                                  selected={containerSelected} onSelectedChange={setContainerSelected}
                                  onDisplayedChange={setContainerDisplayed}
                                  onRefresh={() => void loadRows()}
                                  refreshing={rowsLoading} resetKey={initiativeId} scroller=".kiosk-main" />
            )
          ) : roster.length === 0 ? (
            <div className="dir-empty">No assets found on this move</div>
          ) : (
            <PrintAssetList rows={roster} statusOf={isCustom || !labelType ? null : statusOf}
                            dpisOf={isCustom || !labelType ? null : assetDpis} selected={selected}
                            onSelectedChange={setSelected} onDisplayedChange={setDisplayed}
                            onRefresh={() => void loadRows()} refreshing={rowsLoading}
                            resetKey={initiativeId} scroller=".kiosk-main" />
          )}
        </KioskListPrefsProvider>
      </div>

      {settingsOpen && (
        <BulkPrintSettingsModal settings={settings} onChange={updateSettings}
                                onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );
}
