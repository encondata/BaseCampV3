/**
 * Labels → Printers. Zebra tab: a printer card for the browser-connected
 * (WebUSB) Zebra — connect/disconnect, previously authorized printers,
 * identity (`~HI`) and health (`~HS`) chips — over the tool rows (Test
 * Labels / Install Fonts / Full Printer Setup / Factory Reset)
 * that open their modals. A finished Factory Reset hands its post-reset
 * `^HH` straight into Full Printer Setup. Brother tab: placeholder. No
 * printer registry (spec).
 */
import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '../auth/AuthContext';
import {
  deleteLabelFont, getLabelFontBytes, listLabelFonts, listLabelTemplateTree, listLabelVocab, renderTestLabel,
  uploadLabelFont, type LabelFont, type LabelVocab,
} from '../lib/api';
import { useZebraPrinter } from '../lib/useZebraPrinter';
import type { HostIdentification, HostStatus, PrinterConfiguration, UsbDeviceLike } from '../labels/zebraUsb';
import AlignmentTestModal from '../components/printers/AlignmentTestModal';
import FactoryResetModal from '../components/printers/FactoryResetModal';
import InstallFontsModal from '../components/printers/InstallFontsModal';
import PrinterHealth from '../components/printers/PrinterHealth';
import PrinterSetupModal from '../components/printers/PrinterSetupModal';
import '../styles/access.css';
import '../styles/directory.css';
import '../styles/reports.css';   /* rgm-* modal header/steps, ChoiceCard */
import '../styles/labels.css';
import '../styles/printers.css';

type Tab = 'zebra' | 'brother';
const TABS: { id: Tab; label: string }[] = [{ id: 'zebra', label: 'Zebra Printers' }, { id: 'brother', label: 'Brother Printers' }];

type Tool = 'alignment' | 'fonts' | 'setup' | 'reset';
const ZEBRA_TOOLS: { key: Tool; title: string; description: string; action: string; needsPrinter: boolean; danger?: boolean }[] = [
  { key: 'alignment', title: 'Test Labels', description: 'Print an alignment or sample-data label and dial in offsets.', action: 'Print test label', needsPrinter: true },
  { key: 'fonts', title: 'Install Fonts', description: "Push the house label fonts to the printer's storage.", action: 'Manage fonts', needsPrinter: false },
  { key: 'setup', title: 'Full Printer Setup', description: 'Guided first-time configuration for a new Zebra printer.', action: 'Start setup', needsPrinter: true },
  { key: 'reset', title: 'Factory Reset', description: "Restore the printer's factory defaults, then set it up again.", action: 'Reset printer', needsPrinter: true, danger: true },
];

export default function Printers() {
  const [tab, setTab] = useState<Tab>('zebra');
  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Labels</div>
          <h1 className="page-title">Printers</h1>
          <p className="page-hint">Zebra and Brother label printers — configuration and tools for the printer connected to this computer.</p>
        </div>
      </div>
      <div className="subs-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      <div className="access-tab-panel">
        {tab === 'zebra' && <ZebraTab />}
        {tab === 'brother' && <div className="dir-empty">Brother printer tools are coming soon.</div>}
      </div>
    </div>
  );
}

function ZebraTab() {
  const printer = useZebraPrinter();
  const { can } = useAuth();
  const [vocab, setVocab] = useState<LabelVocab[]>([]);
  const [fonts, setFonts] = useState<LabelFont[] | null>(null);
  const [identity, setIdentity] = useState<HostIdentification | null>(null);
  const [status, setStatus] = useState<HostStatus | null>(null);
  const [known, setKnown] = useState<UsbDeviceLike[]>([]);
  const [tool, setTool] = useState<Tool | null>(null);
  // Set when the setup wizard is opened by a finished factory reset, so it
  // starts from the printer's post-reset configuration instead of re-reading.
  const [fromReset, setFromReset] = useState<{ config: PrinterConfiguration | null } | null>(null);
  const [notice, setNotice] = useState<{ type: string; message: string } | null>(null);

  useEffect(() => {
    listLabelVocab().then(setVocab).catch(() => setNotice({ type: 'error', message: "Couldn't load label sizes." }));
    void printer.knownDevices().then(setKnown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (printer.notice) { setNotice(printer.notice); printer.clearNotice(); }
  }, [printer.notice]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadFonts = useCallback(() => {
    listLabelFonts().then(setFonts).catch(() => setNotice({ type: 'error', message: "Couldn't load the font library." }));
  }, []);
  useEffect(() => { loadFonts(); }, [loadFonts]);

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
    <>
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
            {!printer.supported ? null : printer.connected
              ? <button type="button" className="btn-ghost" onClick={() => void printer.disconnect()}>Disconnect</button>
              : <button type="button" className="btn-solid" onClick={() => void printer.connect()}>Connect via USB</button>}
          </div>
        </div>
        <div className="zp-printer-status">
          <span className={`dot ${printer.connected ? 'on' : 'off'}`} />
          <span className="cell-top">{printer.connected ? `Printer connected${printer.productName ? ` · ${printer.productName}` : ''}` : 'No printer connected'}</span>
        </div>
        {!printer.supported && <p className="page-hint">USB printing needs Chrome or Edge on a secure (https or localhost) address.</p>}
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
      </section>

      <div className="dir-list">
        {ZEBRA_TOOLS.map((t) => {
          const gated = t.needsPrinter && !printer.connected;
          return (
            <div key={t.key} className="dir-row">
              <div className="row-main zp-tool-row">
                <div className="cell">
                  <div className="cell-top"><b>{t.title}</b></div>
                  <div className="cell-sub">{t.description}</div>
                </div>
                <div className="cell zp-tool-action">
                  {gated && <span className="cell-sub">Connect a printer first</span>}
                  <button type="button" className={t.danger ? 'btn-solid btn-danger' : 'btn-solid'} disabled={gated} onClick={() => { setFromReset(null); setTool(t.key); }}>{t.action}</button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {tool === 'alignment' && (
        <AlignmentTestModal vocab={vocab} printerDpi={identity?.dpi ?? null} onPrint={printZpl}
                            loadTemplates={listLabelTemplateTree} renderLabel={renderTestLabel} onClose={() => setTool(null)} />
      )}
      {tool === 'fonts' && (
        <InstallFontsModal printer={printer} fonts={fonts} canAdd={can('labels', 'add')} canDelete={can('labels', 'delete')}
                           onUpload={async (file, name) => { await uploadLabelFont(file, name); loadFonts(); }}
                           onDeleteFont={async (id) => { await deleteLabelFont(id); loadFonts(); }}
                           onFetchBytes={getLabelFontBytes} onClose={() => setTool(null)} />
      )}
      {tool === 'reset' && (
        <FactoryResetModal
          printer={printer}
          identity={identity}
          onDone={(config) => { setFromReset({ config }); setTool('setup'); }}
          onClose={() => { setTool(null); void refreshStatus(); }}
        />
      )}
      {tool === 'setup' && (
        <PrinterSetupModal
          printer={printer} vocab={vocab} identity={identity}
          initialConfig={fromReset?.config ?? undefined}
          intro={fromReset ? 'Printers · After factory reset' : undefined}
          onClose={() => { setTool(null); setFromReset(null); void refreshStatus(); }}
        />
      )}
    </>
  );
}
