/** A platform's own section (`android_rfid` on Android, `ios` on iOS):
 *  read-only in phase 1, shown as the app reported it. */

import { Fragment } from 'react';

import { valueText } from '../../../lib/kioskConfig';
import SettingsCard from './SettingsCard';

const fieldTitle = (k: string) => {
  const words = k.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export default function PlatformSectionCard({ title, value }: { title: string; value: unknown }) {
  const entries = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.entries(value as Record<string, unknown>) : null;
  return (
    <SettingsCard title={title} source="Read-only on the portal for now">
      {entries === null ? (
        <p className="set-note" style={{ padding: 0 }}>Settings not reported by this app version yet</p>
      ) : (
        <dl className="kv">
          {entries.map(([k, v]) => (
            <Fragment key={k}><dt>{fieldTitle(k)}</dt><dd>{valueText(v)}</dd></Fragment>
          ))}
        </dl>
      )}
    </SettingsCard>
  );
}
