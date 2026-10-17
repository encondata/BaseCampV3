/** Settings › Appearance: the three flash colors and the flash length. */

import { Fragment, useState } from 'react';

import {
  FLASH_MS_MAX, FLASH_MS_MIN, hslCss, sectionOf, type AppearanceSection, type Hsl,
} from '../../../lib/kioskConfig';
import HslControl from './HslControl';
import SectionEditModal, { FieldError } from './SectionEditModal';
import SettingsCard from './SettingsCard';
import type { SectionProps } from './types';

const COLORS: { key: 'good_scan' | 'not_found_scan' | 'duplicate_scan'; label: string }[] = [
  { key: 'good_scan', label: 'Good scan flash' },
  { key: 'not_found_scan', label: 'Not-found flash' },
  { key: 'duplicate_scan', label: 'Duplicate flash' },
];

/** A whole number goes as a number; anything else is sent as typed so the
 *  server's 422 names the field. */
export const numberOrRaw = (text: string): number | string =>
  /^\s*\d+\s*$/.test(text) ? Number(text) : text;

function Swatch({ color }: { color: Hsl }) {
  return (
    <span>
      <span className="kd-swatch" style={{ background: hslCss(color) }} aria-hidden="true" />
      <span className="mono">{hslCss(color)}</span>
    </span>
  );
}

function AppearanceModal({ value, onReload, kioskName, onSave, onClose }: {
  onReload?: () => Promise<void>;
  value: AppearanceSection; kioskName: string;
  onSave: (next: AppearanceSection) => Promise<void>; onClose: () => void;
}) {
  const [draft, setDraft] = useState<AppearanceSection>(value);
  const [flash, setFlash] = useState(String(value.flash_ms));
  return (
    <SectionEditModal
      title="Edit appearance" kioskName={kioskName}
      description="The colors the kiosk screen flashes on each scan result, and for how long."
      fields={['appearance.good_scan', 'appearance.not_found_scan', 'appearance.duplicate_scan', 'appearance.flash_ms']}
      onClose={onClose} onReload={onReload}
      onSave={() => onSave({ ...draft, flash_ms: numberOrRaw(flash) as number })}
    >
      {(error) => (
        <div className="pf-form">
          {COLORS.map((c) => (
            <div key={c.key} className="kd-field full">
              <label>{c.label}</label>
              <HslControl name={c.label} value={draft[c.key]}
                          onChange={(next) => setDraft((d) => ({ ...d, [c.key]: next }))} />
              <FieldError error={error} path={`appearance.${c.key}`} />
            </div>
          ))}
          <div className="kd-field">
            <label htmlFor="kd-flash-ms">Flash length</label>
            <input id="kd-flash-ms" aria-label="Flash length (ms)" inputMode="numeric"
                   value={flash} onChange={(e) => setFlash(e.target.value)} />
            <FieldError error={error} path="appearance.flash_ms" />
            <p className="set-note" style={{ padding: 0, marginTop: 6 }}>
              {FLASH_MS_MIN}–{FLASH_MS_MAX} milliseconds.
            </p>
          </div>
        </div>
      )}
    </SectionEditModal>
  );
}

export default function AppearanceCard({ config, kioskName, source, onSave, onReload }: SectionProps) {
  const [editing, setEditing] = useState(false);
  const a = sectionOf(config, 'appearance');
  return (
    <SettingsCard title="Appearance" source={source} onEdit={onSave ? () => setEditing(true) : undefined}>
      <dl className="kv">
        {COLORS.map((c) => (
          <Fragment key={c.key}>
            <dt>{c.label}</dt><dd><Swatch color={a[c.key]} /></dd>
          </Fragment>
        ))}
        <dt>Flash length</dt><dd className="mono">{a.flash_ms} ms</dd>
      </dl>
      {editing && onSave && (
        <AppearanceModal value={a} onReload={onReload} kioskName={kioskName} onClose={() => setEditing(false)}
          onSave={async (next) => { await onSave('appearance', next); setEditing(false); }} />
      )}
    </SettingsCard>
  );
}
