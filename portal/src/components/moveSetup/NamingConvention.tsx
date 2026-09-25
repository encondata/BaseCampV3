/** The convention, count and start fields plus the live preview and clash
 *  line — shared by the crate and truck steps. Pure presentation: the step
 *  owns the value, the generated names, and the server's clashes. */
import type { ChangeEvent } from 'react';

import { clashSentence, namesPreview, type NamingValue } from '../../lib/namingConvention';

interface Props {
  idPrefix: string;
  noun: string;
  max: number;
  value: NamingValue;
  onChange: (value: NamingValue) => void;
  onCountBlur?: () => void;
  names: string[];
  error: string | null;
  clashes: string[];
  checking: boolean;
  disabled?: boolean;
}

export default function NamingConvention({
  idPrefix, noun, max, value, onChange, onCountBlur, names, error, clashes, checking,
  disabled = false,
}: Props) {
  const set = (key: keyof NamingValue) => (e: ChangeEvent<HTMLInputElement>) =>
    onChange({ ...value, [key]: e.target.value });
  const plural = `${noun}${names.length === 1 ? '' : 's'}`;
  return (
    <>
      <div className="pf-form ms-naming">
        <div style={{ gridColumn: '1 / -1' }}>
          <label htmlFor={`${idPrefix}-convention`}>Naming convention</label>
          <input id={`${idPrefix}-convention`} value={value.convention} maxLength={60}
                 spellCheck={false} disabled={disabled} onChange={set('convention')} />
          <span className="page-hint">The x&apos;s mark the number and set its padding: xxx gives 001, 002, 003.</span>
        </div>
        <div>
          <label htmlFor={`${idPrefix}-count`}>Count</label>
          <input id={`${idPrefix}-count`} type="number" min={0} max={max} value={value.count}
                 disabled={disabled} onChange={set('count')} onBlur={onCountBlur} />
        </div>
        <div>
          <label htmlFor={`${idPrefix}-start`}>Start number</label>
          <input id={`${idPrefix}-start`} type="number" min={0} value={value.start}
                 disabled={disabled} onChange={set('start')} />
        </div>
      </div>
      <div className="ms-names" aria-live="polite">
        <span className="eyebrow">Preview</span>
        {error ? <p className="pf-error">{error}</p>
          : names.length === 0
            ? <p className="page-hint">No {noun}s. Set a count to create some, or skip this step.</p>
            : <p className="page-hint">{names.length} {plural}: {namesPreview(names)}</p>}
        {checking && !error && names.length > 0 && (
          <p className="set-note">Checking for names already in use…</p>
        )}
        {clashes.length > 0 && <p className="pf-error">{clashSentence(noun, clashes)}</p>}
      </div>
    </>
  );
}
