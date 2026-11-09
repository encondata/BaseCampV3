/**
 * /labels/printers on a Label Station laptop (and, on its label backend,
 * a web kiosk with a printer saved): the same tools as `PrinterTools`, but
 * on the station's saved printer (`useStationPrinter`), USB or network
 * (USB only on the web), instead of only a WebUSB one.
 *
 * - The card opens on the saved printer: model, firmware and DPI, health
 *   chips, whether a peeler is fitted (step 5's wording) and the saved
 *   offsets.
 * - Test Label Alignment starts from the station's offsets, saves them to
 *   the station (`labelBackend().saveSettings`: `PUT /edge/label-station`
 *   on a laptop, never Print Labels' localStorage settings; this kiosk's
 *   own label settings on the web) and prints in the station's print mode
 *   (`withPrintMode`).
 * - Full Printer Setup and Factory Reset take the USB hook, or a network
 *   printer shaped like it (`networkZebraPrinter`, through the edge).
 * - Change printer and Check printer & fonts open Kiosk Setup's step 5 in
 *   a modal; saving reloads the card. Saving a different DPI or printer
 *   makes the edge (or the web kiosk's build) regenerate the move's labels.
 *
 * Nothing here writes printer settings except Full Printer Setup and
 * Factory Reset, as on every other kiosk.
 *
 * Copy that names the device keeps the laptop's "station" wording on the
 * edge and says "this kiosk" on the web (`OWNER`).
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import type { HostIdentification, HostStatus, PrinterConfiguration } from '@portal/labels/zebraUsb';

import AlignmentTestModal, { type StationOffsets } from '../components/printers/AlignmentTestModal';
import FactoryResetModal from '../components/printers/FactoryResetModal';
import PrinterHealth from '../components/printers/PrinterHealth';
import PrinterSetupModal from '../components/printers/PrinterSetupModal';
import PrinterStep from '../components/setup/PrinterStep';
import { fetchLabelVocab, type LabelVocab } from '../lib/api';
import { useKioskSetup } from '../lib/kioskSetup';
import { labelBackend } from '../lib/labelBackend';
import { LABEL_SECTIONS } from '../lib/labelSections';
import { networkZebraPrinter } from '../lib/networkZebra';
import { withPrintMode, type PeelerInfo } from '../lib/stationPrinter';
import { useStationPrinter } from '../lib/useStationPrinter';

const SECTION = LABEL_SECTIONS.find((s) => s.id === 'printers')!;

type Tool = 'alignment' | 'setup' | 'reset';
type StepModal = 'change' | 'check';

type BackendKind = 'edge' | 'web';

/** How copy names the device: a laptop is a Label Station, as it always
 *  said; a web kiosk is "this kiosk". */
const OWNER: Record<BackendKind, { possessive: string; subject: string; eyebrow: string }> = {
  edge: { possessive: "the station's", subject: 'this station', eyebrow: 'Label Station printer' },
  web: { possessive: "this kiosk's", subject: 'this kiosk', eyebrow: 'Label printer' },
};

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

function tools(kind: BackendKind): { key: Tool; title: string; description: string; action: string; danger?: boolean }[] {
  return [
    { key: 'alignment', title: 'Test Label Alignment', description: `Print a calibration label and dial in ${OWNER[kind].possessive} offsets.`, action: 'Print test label' },
    { key: 'setup', title: 'Full Printer Setup', description: 'Guided first-time configuration for a new Zebra printer.', action: 'Start setup' },
    { key: 'reset', title: 'Factory Reset', description: "Restore the printer's factory defaults, then set it up again.", action: 'Reset printer', danger: true },
  ];
}

/** Change printer's row text: a laptop's printer step is Kiosk Setup's
 *  and offers USB and network; a web kiosk's offers USB only and isn't in
 *  Kiosk Setup (its printer is saved from Label Printing). */
const CHANGE_HINT: Record<BackendKind, string> = {
  edge: "Switch to another USB or network printer. The same checks as Kiosk Setup run before it's saved.",
  web: "Switch to another USB printer. The printer checks run before it's saved.",
};

const STEP_MODALS: Record<StepModal, { title: string; description: string }> = {
  change: {
    title: 'Change printer',
    description: "Pick the station's printer and run the same checks as Kiosk Setup. A printer at a different DPI regenerates the move's labels.",
  },
  check: {
    title: 'Check printer & fonts',
    description: "Run the setup checks on the station's printer again and install any fonts the move's templates need.",
  },
};

/** The step 5 modal's heading text. On the web the printer step isn't
 *  Kiosk Setup's, so neither modal says it is, and the printer is this
 *  kiosk's. */
const WEB_STEP_MODALS: Record<StepModal, { title: string; description: string }> = {
  change: {
    title: STEP_MODALS.change.title,
    description: "Pick this kiosk's printer and run the printer checks. A printer at a different DPI regenerates the move's labels.",
  },
  check: {
    title: STEP_MODALS.check.title,
    description: "Run the printer checks on this kiosk's printer again and install any fonts the move's templates need.",
  },
};

function stepModalText(which: StepModal, kind: BackendKind): { title: string; description: string } {
  return kind === 'web' ? WEB_STEP_MODALS[which] : STEP_MODALS[which];
}

const SWITCH_HINT = 'Run Check printer & fonts to switch.';

/** Step 5's Peeler wording when the printer agrees with the station's
 *  saved mode (`peel`, what the Printing Station actually uses); when it
 *  doesn't, the mode in use and how to switch. `subject` names the device
 *  ("this station", or "this kiosk" on the web). */
function peelerText(present: boolean | null, peel: boolean, subject: string): string {
  if (present === true && !peel) {
    return `Peeler detected, but ${subject} prints in tear-off mode. ${SWITCH_HINT}`;
  }
  if (present === false && peel) {
    return `No peeler found, but ${subject} prints in peel-off mode. ${SWITCH_HINT}`;
  }
  if (present === null && peel) {
    return `Printer doesn't report a peeler, but ${subject} prints in peel-off mode. ${SWITCH_HINT}`;
  }
  if (present === true) return 'Peeler detected · printing in peel-off mode';
  if (present === false) return 'No peeler · printing in tear-off mode';
  return "Printer doesn't report a peeler · printing in tear-off mode";
}

export default function StationPrinterTools() {
  const backend = labelBackend();
  const owner = OWNER[backend.kind];
  // Open from Change printer / Check printer until the reload after it:
  // the modal's step owns the choice of printer meanwhile, so the hook
  // doesn't switch to one picked there (Save printer saves it with the
  // offsets and peel it checked; Close lets go of it).
  const [stepOwnsPrinter, setStepOwnsPrinter] = useState(false);
  const station = useStationPrinter({ holdUsbCheck: stepOwnsPrinter });
  const { settings, printer, zebra, state } = station;
  const [setup] = useKioskSetup();
  const [vocab, setVocab] = useState<LabelVocab[]>([]);
  const [identity, setIdentity] = useState<HostIdentification | null>(null);
  const [status, setStatus] = useState<HostStatus | null>(null);
  const [peeler, setPeeler] = useState<PeelerInfo | null>(null);
  const [tool, setTool] = useState<Tool | null>(null);
  const [stepModal, setStepModal] = useState<StepModal | null>(null);
  const [fromReset, setFromReset] = useState<{ config: PrinterConfiguration | null } | null>(null);
  const [notice, setNotice] = useState<{ type: string; message: string } | null>(null);
  // The USB device held when the step 5 modal opened: one picked there
  // and not saved is let go on close.
  const deviceAtOpen = useRef<unknown>(null);
  // The network printer's command log lives outside React: re-render when it changes.
  const [, logChanged] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    fetchLabelVocab().then(setVocab).catch(() => setNotice({ type: 'error', message: "Couldn't load label sizes." }));
  }, []);

  const ip = settings?.printer.type === 'network' ? settings.printer.ip : null;
  const model = settings?.printer.model ?? null;
  const network = useMemo(
    () => (ip ? networkZebraPrinter(ip, { productName: model, onChange: logChanged }) : null),
    [ip, model],
  );
  // What Full Printer Setup and Factory Reset talk to.
  const toolPrinter = state !== 'ready' ? null : network ?? (zebra.connected ? zebra : null);
  const ready = toolPrinter !== null && printer !== null;

  const refreshStatus = useCallback(async () => {
    if (!printer) { setIdentity(null); setStatus(null); setPeeler(null); return; }
    try {
      setIdentity(await printer.identify());
      setStatus(await printer.status());
      setPeeler(await printer.peeler());
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error && err.message ? err.message : "Couldn't read the printer." });
    }
  }, [printer]);
  useEffect(() => { void refreshStatus(); }, [refreshStatus]);

  const printZpl = async (zpl: string) => {
    if (!printer) throw new Error(`${capitalize(owner.possessive)} printer isn't connected.`);
    await printer.send(zpl);
  };

  const saveOffsets = async (o: StationOffsets) => {
    if (!settings) throw new Error('No saved settings');
    await backend.saveSettings({ ...settings, offset_x: o.x, offset_y: o.y });
    // Saved: a failed re-read doesn't make it "Couldn't save".
    try {
      await station.reload();
    } catch {
      /* the next reload picks the offsets up */
    }
  };

  const openStep = (which: StepModal) => {
    deviceAtOpen.current = zebra.device ?? null;
    setStepOwnsPrinter(true);
    setStepModal(which);
  };

  const closeStep = async (saved: boolean) => {
    setStepModal(null);
    // A USB printer picked in the modal but not saved isn't the station's:
    // let go of it so the saved one is found again (also when the saved
    // printer has no serial, or is a network one).
    try {
      if (!saved && zebra.connected && (zebra.device ?? null) !== deviceAtOpen.current) {
        await zebra.disconnect();
      }
      await station.reload();
    } finally {
      // Checked against what is saved now.
      setStepOwnsPrinter(false);
    }
  };

  let statusText: string;
  if (state === 'loading') statusText = 'Connecting to the label printer…';
  else if (state === 'no_settings') statusText = 'No printer saved';
  else if (state === 'needs_usb') statusText = "The label printer isn't connected";
  else if (settings?.printer.type === 'network') statusText = `Network printer · ${settings.printer.ip}`;
  else statusText = `USB printer · ${zebra.productName || model || 'Zebra printer'}`;

  const log = toolPrinter?.log ?? [];

  return (
    <div className="portal-page">
      <div className="eyebrow">Kiosk · Label Printing</div>
      <h1 className="page-title">{SECTION.title}</h1>
      <p className="page-hint">{SECTION.blurb}</p>
      <p><Link className="mini-btn" to="/labels">Back to Label Printing</Link></p>

      {notice && (
        <div className={`zp-notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>
          <p className="page-hint">{notice.message}</p>
          <button type="button" className="mini-btn" aria-label="Dismiss" onClick={() => setNotice(null)}>×</button>
        </div>
      )}

      <section className="zp-card" aria-label="Printer">
        <div className="zp-card-head">
          <div>
            <span className="eyebrow">{owner.eyebrow}</span>
            <div className="modal-section">Printer</div>
          </div>
          <div className="zp-printer-actions">
            {ready && <button type="button" className="mini-btn" onClick={() => void refreshStatus()}>Refresh status</button>}
            {state === 'needs_usb' && (
              <button type="button" className="btn-solid" onClick={() => void station.connectUsb()}>Connect printer</button>
            )}
          </div>
        </div>
        <div className="zp-printer-status">
          <span className={`dot ${ready ? 'on' : 'off'}`} />
          <span className="cell-top">{statusText}</span>
        </div>
        {state === 'no_settings' && (backend.kind === 'web' ? (
          // A web kiosk's printer is saved in Printer Setup, not Kiosk Setup.
          <p className="page-hint">
            No label printer is saved for this kiosk. Set one up in <Link to={SECTION.path}>Printer Setup</Link>.
          </p>
        ) : (
          <p className="page-hint">
            No label printer is saved for this station. Set one up in <Link to="/setup">Kiosk Setup</Link>.
          </p>
        ))}
        {ready && (
          <>
            <PrinterHealth identity={identity} status={status} productName={toolPrinter?.productName ?? null} />
            <div className="zp-station-facts">
              <div><span className="cell-sub">Peeler</span><span className="cell-top">{peeler ? peelerText(peeler.present, settings?.peel ?? false, owner.subject) : 'Checking…'}</span></div>
              <div><span className="cell-sub">Offsets</span><span className="cell-top">{`Horizontal ${settings?.offset_x ?? 0} dots · Vertical ${settings?.offset_y ?? 0} dots`}</span></div>
            </div>
          </>
        )}
        {toolPrinter && (
          <details className="zp-log">
            <summary className="cell-sub">Command log ({log.length})</summary>
            <div className="zp-actions">
              <button type="button" className="mini-btn" onClick={() => toolPrinter.clearLog()}>Clear</button>
            </div>
            <pre className="mono">{log.map((e) => `${e.at.slice(11, 19)}  ${e.command}`).join('\n')}</pre>
          </details>
        )}
      </section>

      <div className="dir-list">
        {tools(backend.kind).map((t) => (
          <div key={t.key} className="dir-row">
            <div className="row-main zp-tool-row">
              <div className="cell">
                <div className="cell-top"><b>{t.title}</b></div>
                <div className="cell-sub">{t.description}</div>
              </div>
              <div className="cell zp-tool-action">
                {!ready && <span className="cell-sub">Connect a printer first</span>}
                <button type="button" className={t.danger ? 'btn-solid btn-danger' : 'btn-solid'} disabled={!ready}
                        onClick={() => { setFromReset(null); setTool(t.key); }}>{t.action}</button>
              </div>
            </div>
          </div>
        ))}
        <div className="dir-row">
          <div className="row-main zp-tool-row">
            <div className="cell">
              <div className="cell-top"><b>Change printer</b></div>
              <div className="cell-sub">{CHANGE_HINT[backend.kind]}</div>
            </div>
            <div className="cell zp-tool-action">
              <button type="button" className="btn-solid" disabled={!settings} onClick={() => openStep('change')}>Change printer</button>
            </div>
          </div>
        </div>
        <div className="dir-row">
          <div className="row-main zp-tool-row">
            <div className="cell">
              <div className="cell-top"><b>Check printer &amp; fonts</b></div>
              <div className="cell-sub">Run the printer checks again and install the fonts the move&apos;s templates need.</div>
            </div>
            <div className="cell zp-tool-action">
              <button type="button" className="btn-solid" disabled={!settings} onClick={() => openStep('check')}>Check printer</button>
            </div>
          </div>
        </div>
      </div>

      {tool === 'alignment' && settings && (
        <AlignmentTestModal
          vocab={vocab} printerDpi={identity?.dpi ?? settings.dpi} onPrint={printZpl} onClose={() => setTool(null)}
          offsets={{ x: settings.offset_x, y: settings.offset_y }} onSaveOffsets={saveOffsets}
          transform={(zpl) => withPrintMode(zpl, settings.peel)} deviceWord={backend.deviceWord}
        />
      )}
      {tool === 'reset' && toolPrinter && (
        <FactoryResetModal
          printer={toolPrinter}
          identity={identity}
          onDone={(config) => { setFromReset({ config }); setTool('setup'); }}
          onClose={() => { setTool(null); void refreshStatus(); }}
        />
      )}
      {tool === 'setup' && toolPrinter && (
        <PrinterSetupModal
          printer={toolPrinter} vocab={vocab} identity={identity}
          initialConfig={fromReset?.config ?? undefined}
          intro={fromReset ? 'Printers · After factory reset' : undefined}
          onClose={() => { setTool(null); setFromReset(null); void refreshStatus(); }}
        />
      )}
      {stepModal && settings && (
        <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) void closeStep(false); }}>
          <div className="modal-card reports-modal-card rgm-card zp-station-card" role="dialog" aria-label={stepModalText(stepModal, backend.kind).title}>
            <div className="modal-head">
              <div className="rgm-head-text">
                <div className="eyebrow">Printers</div>
                <h3>{stepModalText(stepModal, backend.kind).title}</h3>
                <p className="page-hint">{stepModalText(stepModal, backend.kind).description}</p>
              </div>
              <button type="button" className="modal-close" aria-label="Close" onClick={() => void closeStep(false)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
              </button>
            </div>
            <div className="modal-body">
              <PrinterStep
                initiativeId={setup?.initiativeId ?? ''} labelKind={settings.label_kind} initial={settings}
                finishLabel="Save printer" preselect={stepModal === 'check'} zebra={zebra}
                onFinish={() => void closeStep(true)}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
