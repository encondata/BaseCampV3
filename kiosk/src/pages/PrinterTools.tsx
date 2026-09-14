/**
 * /labels/printers — the portal's Zebra printer tooling, brought to the
 * kiosk (ported from portal/src/pages/Printers.tsx's Zebra tab). One
 * card for the browser-connected (WebUSB) Zebra — connect/disconnect,
 * previously authorized printers, identity (`~HI`) and health (`~HS`)
 * chips, the hook's notice strip and command log — over the tool rows
 * that open Test Label Alignment and Full Printer Setup.
 *
 * No tabs: Brother is not in scope here. Install Fonts is a disabled row
 * ("Managed from the portal") — pushing font bytes needs labels:view on
 * the font library, which a worker does not hold.
 *
 * Label sizes and DPI come from `/kiosk/labels/vocab`, not the portal's
 * labels:view-gated `/labels/vocab` (see `fetchLabelVocab`). Alignment
 * offsets read and write the SAME `labels.print.settings` key the portal
 * uses, so the kiosk's future Printing Station prints with them.
 *
 * WebUSB needs Chrome or Edge on a secure origin (https or localhost) —
 * the kiosk is often a tablet, so an unsupported browser gets a banner
 * and a disabled Connect rather than a button that can only fail.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import type { HostIdentification, HostStatus, UsbDeviceLike } from '@portal/labels/zebraUsb';

import AlignmentTestModal from '../components/printers/AlignmentTestModal';
import PrinterHealth from '../components/printers/PrinterHealth';
import PrinterSetupModal from '../components/printers/PrinterSetupModal';
import { fetchLabelVocab, type LabelVocab } from '../lib/api';
import { LABEL_SECTIONS } from '../lib/labelSections';
import { useZebraPrinter } from '../lib/useZebraPrinter';

const SECTION = LABEL_SECTIONS.find((s) => s.id === 'printers')!;

const UNSUPPORTED = "This browser can't talk to USB printers. Use Chrome or Edge over HTTPS or localhost.";

type Tool = 'alignment' | 'setup';

const TOOLS: { key: Tool; title: string; description: string; action: string }[] = [
  { key: 'alignment', title: 'Test Label Alignment', description: 'Print a calibration label and dial in offsets.', action: 'Print test label' },
  { key: 'setup', title: 'Full Printer Setup', description: 'Guided first-time configuration for a new Zebra printer.', action: 'Start setup' },
];

export default function PrinterTools() {
  const printer = useZebraPrinter();
  const [vocab, setVocab] = useState<LabelVocab[]>([]);
  const [identity, setIdentity] = useState<HostIdentification | null>(null);
  const [status, setStatus] = useState<HostStatus | null>(null);
  const [known, setKnown] = useState<UsbDeviceLike[]>([]);
  const [tool, setTool] = useState<Tool | null>(null);
  const [notice, setNotice] = useState<{ type: string; message: string } | null>(null);

  useEffect(() => {
    fetchLabelVocab().then(setVocab).catch(() => setNotice({ type: 'error', message: "Couldn't load label sizes." }));
    void printer.knownDevices().then(setKnown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (printer.notice) { setNotice(printer.notice); printer.clearNotice(); }
  }, [printer.notice]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshStatus = useCallback(async () => {
    if (!printer.connected) { setIdentity(null); setStatus(null); return; }
    try {
      setIdentity(await printer.identify());
      setStatus(await printer.status());
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : "Couldn't read the printer." });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printer.connected]);
  useEffect(() => { void refreshStatus(); }, [refreshStatus]);

  const printZpl = async (zpl: string) => { await printer.send(zpl); };

  return (
    <div className="portal-page">
      <div className="eyebrow">Kiosk · Label Printing</div>
      <h1 className="page-title">{SECTION.title}</h1>
      <p className="page-hint">{SECTION.blurb}</p>
      <p><Link className="mini-btn" to="/labels">Back to Label Printing</Link></p>

      {!printer.supported && <div className="portal-banner" role="status">{UNSUPPORTED}</div>}

      {notice && (
        <div className={`zp-notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>
          <p className="page-hint">{notice.message}</p>
          <button type="button" className="mini-btn" aria-label="Dismiss" onClick={() => setNotice(null)}>×</button>
        </div>
      )}

      <section className="zp-card" aria-label="Printer">
        <div className="zp-card-head">
          <div>
            <span className="eyebrow">Connected printer</span>
            <div className="modal-section">Printer</div>
          </div>
          <div className="zp-printer-actions">
            {printer.connected && <button type="button" className="mini-btn" onClick={() => void refreshStatus()}>Refresh status</button>}
            {printer.connected
              ? <button type="button" className="btn-ghost" onClick={() => void printer.disconnect()}>Disconnect</button>
              : <button type="button" className="btn-solid" disabled={!printer.supported} onClick={() => void printer.connect()}>Connect via USB</button>}
          </div>
        </div>
        <div className="zp-printer-status">
          <span className={`dot ${printer.connected ? 'on' : 'off'}`} />
          <span className="cell-top">{printer.connected ? `Printer connected${printer.productName ? ` · ${printer.productName}` : ''}` : 'No printer connected'}</span>
        </div>
        {printer.connected && <PrinterHealth identity={identity} status={status} productName={printer.productName} />}
        {!printer.connected && known.length > 0 && (
          <div className="zp-known">
            <span className="cell-sub">Known printers:</span>
            {known.map((d, i) => (
              <button key={i} type="button" className="mini-btn" onClick={() => void printer.connectTo(d)}>Connect {d.productName || 'Zebra printer'}</button>
            ))}
          </div>
        )}
        <p className="page-hint">Requires a Zebra printer connected via USB. Make sure the printer is turned on before connecting.</p>
        <details className="zp-log">
          <summary className="cell-sub">Command log ({printer.log.length})</summary>
          <div className="zp-actions">
            <button type="button" className="mini-btn" onClick={() => printer.clearLog()}>Clear</button>
          </div>
          <pre className="mono">{printer.log.map((e) => `${e.at.slice(11, 19)}  ${e.command}`).join('\n')}</pre>
        </details>
      </section>

      <div className="dir-list">
        {TOOLS.map((t) => {
          const gated = !printer.connected;
          return (
            <div key={t.key} className="dir-row">
              <div className="row-main zp-tool-row">
                <div className="cell">
                  <div className="cell-top"><b>{t.title}</b></div>
                  <div className="cell-sub">{t.description}</div>
                </div>
                <div className="cell zp-tool-action">
                  {gated && <span className="cell-sub">Connect a printer first</span>}
                  <button type="button" className="btn-solid" disabled={gated} onClick={() => setTool(t.key)}>{t.action}</button>
                </div>
              </div>
            </div>
          );
        })}
        <div className="dir-row">
          <div className="row-main zp-tool-row">
            <div className="cell">
              <div className="cell-top"><b>Install Fonts</b></div>
              <div className="cell-sub">Push the house label fonts to the printer&apos;s storage.</div>
            </div>
            <div className="cell zp-tool-action">
              <span className="cell-sub">Managed from the portal</span>
              <button type="button" className="btn-solid" disabled>Manage fonts</button>
            </div>
          </div>
        </div>
      </div>

      {tool === 'alignment' && <AlignmentTestModal vocab={vocab} printerDpi={identity?.dpi ?? null} onPrint={printZpl} onClose={() => setTool(null)} />}
      {tool === 'setup' && <PrinterSetupModal printer={printer} vocab={vocab} identity={identity} onClose={() => { setTool(null); void refreshStatus(); }} />}
    </div>
  );
}
