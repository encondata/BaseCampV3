/**
 * /labels/printers on a Label Station laptop: the same tools as
 * `PrinterTools`, but on the station's saved printer (`useStationPrinter`),
 * USB or network, instead of only a WebUSB one.
 *
 * - The card opens on the saved printer: model, firmware and DPI, health
 *   chips, whether a peeler is fitted (step 5's wording) and the saved
 *   offsets.
 * - Test Label Alignment starts from the station's offsets, saves them to
 *   the station (`PUT /edge/label-station`, never localStorage) and prints
 *   in the station's print mode (`withPrintMode`).
 * - Full Printer Setup and Factory Reset take the USB hook, or a network
 *   printer shaped like it (`networkZebraPrinter`, through the edge).
 * - Change printer and Check printer & fonts open Kiosk Setup's step 5 in
 *   a modal; saving reloads the card. Saving a different DPI or printer
 *   makes the edge regenerate the move's labels.
 *
 * Nothing here writes printer settings except Full Printer Setup and
 * Factory Reset, as on every other kiosk.
 */
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { Link } from 'react-router-dom';

import type { HostIdentification, HostStatus, PrinterConfiguration } from '@portal/labels/zebraUsb';

import AlignmentTestModal, { type StationOffsets } from '../components/printers/AlignmentTestModal';
import FactoryResetModal from '../components/printers/FactoryResetModal';
import PrinterHealth from '../components/printers/PrinterHealth';
import PrinterSetupModal from '../components/printers/PrinterSetupModal';
import PrinterStep from '../components/setup/PrinterStep';
import { fetchLabelVocab, putLabelStation, type LabelVocab } from '../lib/api';
import { useKioskSetup } from '../lib/kioskSetup';
import { LABEL_SECTIONS } from '../lib/labelSections';
import { networkZebraPrinter } from '../lib/networkZebra';
import { withPrintMode, type PeelerInfo } from '../lib/stationPrinter';
import { useStationPrinter } from '../lib/useStationPrinter';

const SECTION = LABEL_SECTIONS.find((s) => s.id === 'printers')!;

type Tool = 'alignment' | 'setup' | 'reset';
type StepModal = 'change' | 'check';

const TOOLS: { key: Tool; title: string; description: string; action: string; danger?: boolean }[] = [
  { key: 'alignment', title: 'Test Label Alignment', description: "Print a calibration label and dial in the station's offsets.", action: 'Print test label' },
  { key: 'setup', title: 'Full Printer Setup', description: 'Guided first-time configuration for a new Zebra printer.', action: 'Start setup' },
  { key: 'reset', title: 'Factory Reset', description: "Restore the printer's factory defaults, then set it up again.", action: 'Reset printer', danger: true },
];

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

/** Step 5's Peeler wording. */
function peelerText(present: boolean | null): string {
  if (present === true) return 'Peeler detected · printing in peel-off mode';
  if (present === false) return 'No peeler · printing in tear-off mode';
  return "Printer doesn't report a peeler · printing in tear-off mode";
}

function serialOf(device: unknown): string | null {
  const serial = (device as { serialNumber?: unknown } | null | undefined)?.serialNumber;
  return typeof serial === 'string' && serial ? serial : null;
}

export default function StationPrinterTools() {
  const station = useStationPrinter();
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
    if (!printer) throw new Error("The station's printer isn't connected.");
    await printer.send(zpl);
  };

  const saveOffsets = async (o: StationOffsets) => {
    if (!settings) throw new Error('No saved settings');
    await putLabelStation({ ...settings, offset_x: o.x, offset_y: o.y });
    await station.reload();
  };

  const closeStep = async (saved: boolean) => {
    setStepModal(null);
    // A USB printer picked in the modal but not saved isn't the station's:
    // let go of it so the saved one is found again.
    if (!saved && settings?.printer.type === 'usb' && settings.printer.serial
        && zebra.connected && serialOf(zebra.device) !== settings.printer.serial) {
      await zebra.disconnect();
    }
    await station.reload();
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
            <span className="eyebrow">Label Station printer</span>
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
        {state === 'no_settings' && (
          <p className="page-hint">
            No label printer is saved for this station. Set one up in <Link to="/setup">Kiosk Setup</Link>.
          </p>
        )}
        {ready && (
          <>
            <PrinterHealth identity={identity} status={status} productName={toolPrinter?.productName ?? null} />
            <div className="zp-station-facts">
              <div><span className="cell-sub">Peeler</span><span className="cell-top">{peeler ? peelerText(peeler.present) : 'Checking…'}</span></div>
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
        {TOOLS.map((t) => (
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
              <div className="cell-sub">Switch to another USB or network printer. The same checks as Kiosk Setup run before it&apos;s saved.</div>
            </div>
            <div className="cell zp-tool-action">
              <button type="button" className="btn-solid" disabled={!settings} onClick={() => setStepModal('change')}>Change printer</button>
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
              <button type="button" className="btn-solid" disabled={!settings} onClick={() => setStepModal('check')}>Check printer</button>
            </div>
          </div>
        </div>
      </div>

      {tool === 'alignment' && settings && (
        <AlignmentTestModal
          vocab={vocab} printerDpi={identity?.dpi ?? settings.dpi} onPrint={printZpl} onClose={() => setTool(null)}
          offsets={{ x: settings.offset_x, y: settings.offset_y }} onSaveOffsets={saveOffsets}
          transform={(zpl) => withPrintMode(zpl, settings.peel)}
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
          <div className="modal-card reports-modal-card rgm-card zp-station-card" role="dialog" aria-label={STEP_MODALS[stepModal].title}>
            <div className="modal-head">
              <div className="rgm-head-text">
                <div className="eyebrow">Printers</div>
                <h3>{STEP_MODALS[stepModal].title}</h3>
                <p className="page-hint">{STEP_MODALS[stepModal].description}</p>
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
