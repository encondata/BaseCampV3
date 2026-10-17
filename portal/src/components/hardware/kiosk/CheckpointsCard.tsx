/** Settings › Checkpoints: the scan type each non-scanning kiosk screen
 *  records (RFID Enroll, Containers › Pack/Unpack, Trucks › Load/Unload),
 *  picked from the asset status vocabulary as on the kiosk's Admin tab. */

import { Fragment, useState } from 'react';

import ComboBox, { type ComboOption } from '../../ComboBox';
import type { StatusValue } from '../../../lib/api';
import { CHECKPOINTS, sectionOf, type CheckpointsSection } from '../../../lib/kioskConfig';
import SectionEditModal, { FieldError } from './SectionEditModal';
import SettingsCard from './SettingsCard';
import type { SectionProps } from './types';

const labelOf = (key: string, statuses: StatusValue[] | null) =>
  statuses?.find((s) => s.record_type === 'asset' && s.key === key)?.label ?? key;

function options(statuses: StatusValue[] | null, current: string[]): ComboOption[] {
  const active = (statuses ?? []).filter((s) => s.record_type === 'asset' && s.is_active);
  const out: ComboOption[] = active.map((s) => ({ value: s.key, label: s.label }));
  // a stored key that's retired (or a vocabulary that failed to load) still shows
  for (const k of current) {
    if (!out.some((o) => o.value === k)) out.push({ value: k, label: labelOf(k, statuses), sub: 'Not in the active list' });
  }
  return out;
}

function CheckpointsModal({ value, statuses, kioskName, onSave, onClose }: {
  value: CheckpointsSection; statuses: StatusValue[] | null; kioskName: string;
  onSave: (next: CheckpointsSection) => Promise<void>; onClose: () => void;
}) {
  const [draft, setDraft] = useState<CheckpointsSection>(value);
  const opts = options(statuses, CHECKPOINTS.map((c) => draft[c.key]));
  return (
    <SectionEditModal
      title="Edit checkpoints" kioskName={kioskName}
      description="The scan type each kiosk screen records: what an enroll, pack, unpack, load or unload marks an asset as."
      fields={CHECKPOINTS.map((c) => `checkpoints.${c.key}`)}
      onClose={onClose}
      onSave={() => onSave(draft)}
    >
      {(error) => (
        <div className="pf-form">
          {CHECKPOINTS.map((c) => (
            <div key={c.key} className="kd-field">
              <label>{c.label}</label>
              <ComboBox ariaLabel={`${c.label} checkpoint`} options={opts} value={draft[c.key]}
                        onChange={(v) => { if (v) setDraft((d) => ({ ...d, [c.key]: v })); }} />
              <FieldError error={error} path={`checkpoints.${c.key}`} />
            </div>
          ))}
        </div>
      )}
    </SectionEditModal>
  );
}

export default function CheckpointsCard({
  config, kioskName, source, onSave, statuses,
}: SectionProps & { statuses: StatusValue[] | null }) {
  const [editing, setEditing] = useState(false);
  const c = sectionOf(config, 'checkpoints');
  return (
    <SettingsCard title="Checkpoints" source={source} onEdit={onSave ? () => setEditing(true) : undefined}>
      <dl className="kv">
        {CHECKPOINTS.map((row) => (
          <Fragment key={row.key}>
            <dt>{row.label}</dt><dd>{labelOf(c[row.key], statuses)}</dd>
          </Fragment>
        ))}
      </dl>
      {editing && onSave && (
        <CheckpointsModal value={c} statuses={statuses} kioskName={kioskName}
          onClose={() => setEditing(false)}
          onSave={async (next) => { await onSave('checkpoints', next); setEditing(false); }} />
      )}
    </SettingsCard>
  );
}
