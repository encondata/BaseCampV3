/** Settings › Developer: the kiosk's developer mode switch. */

import { useState } from 'react';

import { sectionOf, type DeveloperSection } from '../../../lib/kioskConfig';
import { Switch } from '../../Switch';
import SectionEditModal, { FieldError } from './SectionEditModal';
import SettingsCard from './SettingsCard';
import type { SectionProps } from './types';

function DeveloperModal({ value, kioskName, onSave, onClose }: {
  value: DeveloperSection; kioskName: string;
  onSave: (next: DeveloperSection) => Promise<void>; onClose: () => void;
}) {
  const [draft, setDraft] = useState<DeveloperSection>(value);
  return (
    <SectionEditModal
      title="Edit developer" kioskName={kioskName}
      description="Developer mode shows the kiosk's diagnostic tools to developers signed in on it."
      fields={['developer.dev_mode']}
      onClose={onClose}
      onSave={() => onSave(draft)}
    >
      {(error) => (
        <div className="pf-form">
          <div className="kd-field full">
            <label>Developer mode</label>
            <div className="kd-switch-line">
              <Switch checked={draft.dev_mode} label="Developer mode"
                      onChange={(v) => setDraft((d) => ({ ...d, dev_mode: v }))} />
              <span>{draft.dev_mode ? 'On' : 'Off'}</span>
            </div>
            <FieldError error={error} path="developer.dev_mode" />
          </div>
        </div>
      )}
    </SectionEditModal>
  );
}

export default function DeveloperCard({ config, kioskName, source, onSave }: SectionProps) {
  const [editing, setEditing] = useState(false);
  const d = sectionOf(config, 'developer');
  return (
    <SettingsCard title="Developer" source={source} onEdit={onSave ? () => setEditing(true) : undefined}>
      <dl className="kv">
        <dt>Developer mode</dt>
        <dd>{d.dev_mode ? <span className="chip c-amber">On</span> : <span className="chip tag">Off</span>}</dd>
      </dl>
      {editing && onSave && (
        <DeveloperModal value={d} kioskName={kioskName} onClose={() => setEditing(false)}
          onSave={async (next) => { await onSave('developer', next); setEditing(false); }} />
      )}
    </SettingsCard>
  );
}
