/** The Linux laptop's battery and network in the kiosk top bar (first in
 *  .kiosk-user). Tapping the network opens the Network modal, portaled into
 *  the shell so the top bar's own button styles don't reach it. Renders
 *  nothing off a Linux laptop, and nothing until the helper first answers. */

import { useState } from 'react';
import { createPortal } from 'react-dom';

import { lockdownAvailable } from '../../lib/hostHelper';
import { useHostSystem } from '../../lib/useHostSystem';
import NetworkModal from './NetworkModal';

export function signalBars(signal: number): 0 | 1 | 2 | 3 {
  if (signal <= 0) return 0;
  if (signal <= 33) return 1;
  if (signal <= 66) return 2;
  return 3;
}

function BatteryIcon({ percent, charging }: { percent: number; charging: boolean }) {
  const fill = Math.round((14 * Math.max(0, Math.min(100, percent))) / 100);
  return (
    <svg className="kiosk-sys-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2" y="7" width="18" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <rect x="21" y="10" width="2" height="4" rx="1" fill="currentColor" />
      <rect x="4" y="9" width={fill} height="6" rx="1" fill="currentColor" opacity={charging ? 0.35 : 1} />
      {charging && <path d="M12.5 7.5 8.5 12.5h3l-1 4 4-5h-3z" fill="currentColor" />}
    </svg>
  );
}

function WifiIcon({ bars }: { bars: 0 | 1 | 2 | 3 }) {
  const on = (n: number) => (bars >= n ? 1 : 0.3);
  return (
    <svg className="kiosk-sys-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" aria-hidden="true">
      <path d="M2.5 9a14 14 0 0 1 19 0" opacity={on(3)} />
      <path d="M5.5 12.5a9.5 9.5 0 0 1 13 0" opacity={on(2)} />
      <path d="M8.5 16a5 5 0 0 1 7 0" opacity={on(1)} />
      <circle cx="12" cy="19" r="1.2" fill="currentColor" stroke="none" opacity={bars > 0 ? 1 : 0.3} />
    </svg>
  );
}

function WiredIcon() {
  return (
    <svg className="kiosk-sys-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="6" y="3" width="12" height="9" rx="1.5" />
      <path d="M9 6v2M12 6v2M15 6v2M12 12v4M6 16h12v5H6z" />
    </svg>
  );
}

export default function SystemTray() {
  const { system, refresh } = useHostSystem();
  const [open, setOpen] = useState(false);
  if (!lockdownAvailable() || !system) return null;
  const { battery, wifi, network } = system;
  const label = network === 'wifi' && wifi ? wifi.ssid : network === 'wired' ? 'Wired' : 'No network';
  const host = document.querySelector('.portal-shell.kiosk-shell:not(.kiosk-pin-host)') ?? document.body;
  return (
    <>
      {battery && (
        <span className="kiosk-sys-item" title={`Battery ${battery.percent}%${battery.charging ? ', charging' : ''}`}>
          <BatteryIcon percent={battery.percent} charging={battery.charging} />
          <span>{battery.percent}%</span>
        </span>
      )}
      <button type="button" className="kiosk-sys-btn" aria-label={`Network: ${label}`}
              title={wifi ? `${wifi.ssid} · ${wifi.signal}% signal` : label} onClick={() => setOpen(true)}>
        {network === 'wired' ? <WiredIcon /> : <WifiIcon bars={wifi ? signalBars(wifi.signal) : 0} />}
        <span>{label}</span>
      </button>
      {open && createPortal(
        <NetworkModal onClose={() => setOpen(false)} onChanged={() => void refresh()} />, host)}
    </>
  );
}
