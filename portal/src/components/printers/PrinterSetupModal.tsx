/**
 * Printers › Full printer setup — a stepped wizard (Identify › Media ›
 * Print quality › Save & verify) against the connected Zebra. Every
 * Apply sends only the changed commands, re-reads `^HH`, and marks each
 * value confirmed or "printer reports X". A Command log disclosure shows
 * the hook's log so support can see exactly what was sent.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { LabelVocab } from '../../lib/api';
import { sizeMeta, vocabOfKind } from '../../lib/labels';
import { alignmentTestZpl, applyPrintSettings, readPrintSettings } from '../../lib/printLabels';
import type { ZebraPrinter } from '../../lib/useZebraPrinter';
import {
  CALIBRATE, FACTORY_DEFAULTS, PRINT_CONFIGURATION_LABEL, SAVE_SETTINGS, configurationQuery,
} from '../../labels/zebraCommands';
import {
  commandsForMedia, commandsForQuality, confirmMedia, confirmQuality, mediaChoicesFromConfig, qualityFromConfig,
  type MediaChoices, type QualityChoices,
} from '../../labels/zebraSetup';
import { parseConfiguration, type HostIdentification, type HostStatus, type PrinterConfiguration } from '../../labels/zebraUsb';
import ComboBox from '../ComboBox';
import { ChoiceCard } from '../reports/ReportOptionsLayout';
import PrinterHealth from './PrinterHealth';

type Step = 'identify' | 'media' | 'quality' | 'save';
const STEPS: { id: Step; label: string }[] = [
  { id: 'identify', label: 'Identify' }, { id: 'media', label: 'Media' }, { id: 'quality', label: 'Print quality' }, { id: 'save', label: 'Save & verify' },
];
const SETTLE_MS = 750;

interface Props {
  printer: Pick<ZebraPrinter, 'query' | 'send' | 'identify' | 'status' | 'log' | 'clearLog' | 'productName'>;
  vocab: LabelVocab[];
  identity: HostIdentification | null;
  onClose: () => void;
}

const CONFIG_ITEMS: { key: keyof PrinterConfiguration; label: string; fmt?: (v: number) => string }[] = [
  { key: 'darkness', label: 'Darkness' }, { key: 'printSpeed', label: 'Print speed', fmt: (v) => `${v} ips` },
  { key: 'printMode', label: 'Print mode' }, { key: 'mediaType', label: 'Media type' }, { key: 'printMethod', label: 'Print method' },
  { key: 'printWidth', label: 'Print width', fmt: (v) => `${v} dots` }, { key: 'labelLength', label: 'Label length', fmt: (v) => `${v} dots` },
  { key: 'firmware', label: 'Firmware' },
];

export default function PrinterSetupModal({ printer, vocab, identity: identityIn, onClose }: Props) {
  const [step, setStep] = useState<Step>('identify');
  const [identity, setIdentity] = useState(identityIn);
  const [status, setStatus] = useState<HostStatus | null>(null);
  const [config, setConfig] = useState<PrinterConfiguration | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [media, setMedia] = useState<MediaChoices>(mediaChoicesFromConfig(null));
  const [mediaResult, setMediaResult] = useState<ReturnType<typeof confirmMedia> | null>(null);
  const [quality, setQuality] = useState<QualityChoices>({ darkness: null, speed: null });
  const [qualityResult, setQualityResult] = useState<ReturnType<typeof confirmQuality> | null>(null);
  const [sizeKey, setSizeKey] = useState('');
  const [resetText, setResetText] = useState('');
  const [saveNotice, setSaveNotice] = useState('');
  const dpi = identity?.dpi ?? 203;
  const sizes = useMemo(() => vocabOfKind(vocab, 'size'), [vocab]);

  const printerRef = useRef(printer);
  printerRef.current = printer;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const readAll = async () => {
    setReading(true);
    setError('');
    try {
      const [id, st, cfgText] = [await printerRef.current.identify(), await printerRef.current.status(), await printerRef.current.query(configurationQuery())];
      if (id) setIdentity(id);
      setStatus(st);
      const cfg = parseConfiguration(cfgText);
      setConfig(cfg);
      if (!cfg) setError("Couldn't read the printer's configuration (^HH).");
      const m = mediaChoicesFromConfig(cfg);
      setMedia(m);
      setQuality(qualityFromConfig(cfg));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Printer read failed');
    } finally {
      setReading(false);
    }
  };
  useEffect(() => { void readAll(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const reread = async () => {
    const cfg = parseConfiguration(await printerRef.current.query(configurationQuery()));
    setConfig(cfg);
    return cfg;
  };

  const applyMedia = async () => {
    setBusy(true); setError(''); setMediaResult(null);
    try {
      const size = sizes.find((s) => s.key === sizeKey);
      const next: MediaChoices = size
        ? { ...media, widthDots: Math.round(sizeMeta(size).width_in * dpi), lengthDots: Math.round(sizeMeta(size).height_in * dpi) }
        : media;
      for (const cmd of commandsForMedia(mediaChoicesFromConfig(config), next)) await printerRef.current.send(cmd);
      await sleep(SETTLE_MS);
      const cfg = await reread();
      setMediaResult(confirmMedia(cfg, next));
      setMedia(next);
    } catch (err) { setError(err instanceof Error ? err.message : 'Apply failed'); } finally { setBusy(false); }
  };

  const applyQuality = async () => {
    setBusy(true); setError(''); setQualityResult(null);
    try {
      for (const cmd of commandsForQuality(qualityFromConfig(config), quality)) await printerRef.current.send(cmd);
      await sleep(SETTLE_MS);
      setQualityResult(confirmQuality(await reread(), quality));
    } catch (err) { setError(err instanceof Error ? err.message : 'Apply failed'); } finally { setBusy(false); }
  };

  const sendOne = async (cmd: string, done: string) => {
    setBusy(true); setError(''); setSaveNotice('');
    try { await printerRef.current.send(cmd); setSaveNotice(done); } catch (err) { setError(err instanceof Error ? err.message : 'Command failed'); } finally { setBusy(false); }
  };

  const printAlignment = async () => {
    const size = sizes.find((s) => s.key === (sizeKey || '4x2')) ?? sizes[0];
    if (!size) return;
    const { width_in, height_in } = sizeMeta(size);
    const zpl = applyPrintSettings(alignmentTestZpl(Math.round(width_in * dpi), Math.round(height_in * dpi), size.key, dpi), readPrintSettings(), { singleCopy: true });
    await sendOne(zpl, `Alignment test label (${size.key}) sent to printer`);
  };

  const confirmLine = (label: string, ok: boolean | null, reported: string | null) => ok === null ? null : (
    <span key={label} className={`chip ${ok ? 'c-green' : 'c-amber'}`}>{ok ? `${label} confirmed` : `${label}: printer reports ${reported ?? 'unknown'}`}</span>
  );

  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const next = () => setStep(STEPS[Math.min(stepIndex + 1, STEPS.length - 1)].id);
  const back = () => setStep(STEPS[Math.max(stepIndex - 1, 0)].id);

  let body: ReactNode;
  if (step === 'identify') {
    body = (
      <>
        <PrinterHealth identity={identity} status={status} productName={printer.productName} />
        <div className="modal-section">Current configuration</div>
        {reading && !config ? <p className="page-hint">Reading the printer…</p> : config ? (
          <div className="zp-config-grid">
            {CONFIG_ITEMS.map((it) => {
              const v = config[it.key];
              const text = v === null || v === undefined ? '—' : typeof v === 'number' && it.fmt ? it.fmt(v) : String(v);
              return <div key={it.key} className="zp-config-item"><span className="cell-sub">{it.label}</span><span className="cell-top">{text}</span></div>;
            })}
          </div>
        ) : <p className="page-hint">No configuration read yet.</p>}
      </>
    );
  } else if (step === 'media') {
    body = (
      <>
        <div className="modal-section">Media tracking</div>
        <div className="zp-choices" role="radiogroup" aria-label="Media tracking">
          {([['W', 'Gap / notch', 'Die-cut labels with a gap or notch between them'], ['M', 'Black mark', 'Labels with a black mark on the back'], ['N', 'Continuous', 'Continuous stock, no gaps']] as const).map(([v, t, d]) => (
            <ChoiceCard key={v} title={t} description={d} selected={media.tracking === v} onSelect={() => setMedia({ ...media, tracking: v })} />
          ))}
        </div>
        <div className="modal-section">Print method</div>
        <div className="zp-choices" role="radiogroup" aria-label="Print method">
          {([['D', 'Direct thermal', 'Heat-sensitive labels, no ribbon'], ['T', 'Thermal transfer', 'Ribbon required']] as const).map(([v, t, d]) => (
            <ChoiceCard key={v} title={t} description={d} selected={media.method === v} onSelect={() => setMedia({ ...media, method: v })} />
          ))}
        </div>
        <div className="modal-section">Print mode</div>
        <div className="zp-choices" role="radiogroup" aria-label="Print mode">
          {([['T', 'Tear-off', 'Labels stop at the tear bar'], ['P', 'Peel', 'Backing peels away after each label'], ['C', 'Cutter', 'Each label is cut']] as const).map(([v, t, d]) => (
            <ChoiceCard key={v} title={t} description={d} selected={media.mode === v} onSelect={() => setMedia({ ...media, mode: v })} />
          ))}
        </div>
        <div className="modal-section">Label size</div>
        <ComboBox options={sizes.map((s) => ({ value: s.key, label: s.label }))} value={sizeKey} onChange={setSizeKey} placeholder="Keep the printer's current size…" clearable />
        <p className="page-hint">{sizeKey ? `Sets ^PW/^LL for ${sizes.find((s) => s.key === sizeKey)?.label} at ${dpi} DPI.` : `Current: ${media.widthDots ?? '—'} × ${media.lengthDots ?? '—'} dots.`}</p>
        <div className="zp-actions">
          <button type="button" className="mini-btn" disabled={busy} onClick={() => void sendOne(CALIBRATE, 'Calibration started — the printer feeds a few labels.')}>Calibrate media</button>
          <span className="cell-sub">Calibration feeds a few labels while the sensor learns the media.</span>
        </div>
        {mediaResult && (
          <div className="zp-chips">
            {confirmLine('Media tracking', mediaResult.tracking, config?.mediaType ?? null)}
            {confirmLine('Print method', mediaResult.method, config?.printMethod ?? null)}
            {confirmLine('Print mode', mediaResult.mode, config?.printMode ?? null)}
            {confirmLine('Label size', mediaResult.size, config ? `${config.printWidth ?? '—'} × ${config.labelLength ?? '—'}` : null)}
          </div>
        )}
      </>
    );
  } else if (step === 'quality') {
    body = (
      <>
        <div className="modal-section">Darkness</div>
        <div className="zp-range">
          <input type="range" min={0} max={30} step={1} aria-label="Darkness" value={quality.darkness ?? 10} onChange={(e) => setQuality({ ...quality, darkness: Number(e.target.value) })} />
          <span className="mono">{quality.darkness ?? '—'}</span>
        </div>
        <p className="page-hint">0–30. Higher prints darker and wears the head faster.</p>
        <div className="modal-section">Print speed</div>
        <div className="zp-range">
          <input type="range" min={2} max={14} step={1} aria-label="Print speed" value={quality.speed ?? 6} onChange={(e) => setQuality({ ...quality, speed: Number(e.target.value) })} />
          <span className="mono">{quality.speed ?? '—'} ips</span>
        </div>
        <p className="page-hint">2–14 inches per second. Slower is crisper on barcodes.</p>
        {qualityResult && (
          <div className="zp-chips">
            {confirmLine('Darkness', qualityResult.darkness, config?.darkness != null ? String(config.darkness) : null)}
            {confirmLine('Print speed', qualityResult.speed, config?.printSpeed != null ? `${config.printSpeed} ips` : null)}
          </div>
        )}
      </>
    );
  } else {
    body = (
      <>
        <p className="page-hint">Settings live in the printer's working memory until saved. Save to keep them across a power cycle.</p>
        <div className="zp-actions">
          <button type="button" className="btn-solid" disabled={busy} onClick={() => void sendOne(SAVE_SETTINGS, 'Settings saved to the printer.')}>Save to printer</button>
          <button type="button" className="mini-btn" disabled={busy} onClick={() => void sendOne(PRINT_CONFIGURATION_LABEL, 'Configuration label sent to printer.')}>Print configuration label</button>
          <button type="button" className="mini-btn" disabled={busy} onClick={() => void printAlignment()}>Print alignment test</button>
        </div>
        {saveNotice && <div className="zp-notice success" role="status"><p className="page-hint">{saveNotice}</p></div>}
        <div className="modal-section">Danger zone</div>
        <div className="zp-guard">
          <label htmlFor="zp-reset" className="cell-sub">Type RESET to confirm</label>
          <input id="zp-reset" aria-label="Type RESET to confirm" value={resetText} onChange={(e) => setResetText(e.target.value)} />
          <button type="button" className="mini-btn danger" disabled={busy || resetText !== 'RESET'}
                  onClick={() => { setResetText(''); void sendOne(FACTORY_DEFAULTS, 'Factory defaults restored — re-run Identify to see the new configuration.'); }}>Restore factory defaults</button>
        </div>
      </>
    );
  }

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card zp-setup-card" role="dialog" aria-label="Full printer setup">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Printers</div>
            <h3>Full printer setup</h3>
            <p className="page-hint">Guided configuration for the connected Zebra printer. Each step sends the commands and reads the printer back to confirm.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="rgm-steps">
          {STEPS.map((s, i) => (
            <span key={s.id} style={{ display: 'contents' }}>
              {i > 0 && <span className="rgm-step-sep" />}
              <span className={`rgm-step ${step === s.id ? 'on' : ''} ${i < stepIndex ? 'done' : ''}`}>
                <span className="rgm-step-num">{i + 1}</span><span className="rgm-step-label">{s.label}</span>
              </span>
            </span>
          ))}
        </div>
        <div className="modal-body">
          <div className="zp-col">{body}</div>
          {error && <div className="zp-notice error" role="alert"><p className="page-hint">{error}</p></div>}
          <details className="zp-log">
            <summary className="cell-sub">Command log ({printer.log.length})</summary>
            <pre className="mono">{printer.log.map((e) => `${e.at.slice(11, 19)}  ${e.command}${e.response ? `\n          ← ${e.response.replace(/[\x02\x03]/g, '')}` : ''}`).join('\n')}</pre>
          </details>
        </div>
        <div className="modal-foot">
          {step === 'identify' && <button type="button" className="mini-btn" disabled={reading || busy} onClick={() => void readAll()}>Refresh</button>}
          {step !== 'identify' && <button type="button" className="mini-btn" disabled={busy} onClick={back}>Back</button>}
          {step === 'media' && <button type="button" className="btn-solid" disabled={busy || !config} onClick={() => void applyMedia()}>Apply</button>}
          {step === 'quality' && <button type="button" className="btn-solid" disabled={busy || !config} onClick={() => void applyQuality()}>Apply</button>}
          {step !== 'save' && <button type="button" className={step === 'identify' ? 'btn-solid' : 'mini-btn'} disabled={busy} onClick={next}>Next</button>}
          {step === 'save' && <button type="button" className="btn-solid" disabled={busy} onClick={onClose}>Done</button>}
        </div>
      </div>
    </div>
  );
}
