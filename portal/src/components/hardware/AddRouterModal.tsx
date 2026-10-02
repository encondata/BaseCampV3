/** "How to add a router": the one-line installer for a GL.iNet router,
 *  filled in with this deployment's API address. Routers register
 *  themselves; this modal only explains how and hands over the command.
 *  Report-generate header (eyebrow / title / description) per the house
 *  modal pattern. */

import { useState } from 'react';

import { routerInstallCommand } from '../../lib/devices';
import '../../styles/reports.css';
import '../../styles/hardware.css';

export default function AddRouterModal({ apiBase, onClose }: {
  apiBase: string; onClose: () => void;
}) {
  const command = routerInstallCommand(apiBase);
  const [copied, setCopied] = useState(false);
  const insecure = !/^https:\/\//i.test(apiBase);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card add-router-card" role="dialog"
           aria-label="Add a router">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Scanning Hardware</div>
            <h3>Add a router</h3>
            <p className="page-hint">
              GL.iNet routers (GL-AC2100, GL-MT3000) register themselves once the agent is installed.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <ol className="add-router-steps">
            <li>Sign in to the router over SSH as <code>root</code> (same password as its admin page).</li>
            <li>Paste this command and press Enter:</li>
          </ol>
          <div className="add-router-cmd">
            <code>{command}</code>
            <button type="button" className="mini-btn" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          {insecure && (
            <p className="set-note router-warn" style={{ padding: 0 }}>
              This portal&apos;s API address isn&apos;t HTTPS, so the installer will refuse it.
              Use the deployment&apos;s public HTTPS API address instead.
            </p>
          )}
          <ol className="add-router-steps" start={3}>
            <li>
              The router appears here as <b>Pending</b> and everyone who manages scanning hardware
              gets an approval notification. Nothing it reports is stored until it&apos;s approved.
            </li>
            <li>
              Approve it from the notification or the row&apos;s Actions menu. Approval lasts until
              you revoke it; reinstalling the agent keeps the router&apos;s secret, so it stays approved.
            </li>
          </ol>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-solid" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
