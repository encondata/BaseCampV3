/**
 * Rows for the setup checks (the RFID Network check and final check, and
 * the Label Station's printer checks): a spinner while a row runs, a green
 * check when it passed, a red X with its detail when it failed, a muted
 * dot until it has run. A row marked `showOkDetail` (an informational
 * check that always passes) shows its detail, muted, when it passed too.
 */

import type { CheckName } from '../../lib/api';

/** The part of a check's result a row shows. */
export interface CheckRowResult { state: 'ok' | 'fail' | 'unknown'; detail?: string }

interface Props<N extends string> {
  items: { name: N; label: string; showOkDetail?: boolean }[];
  results: Partial<Record<N, CheckRowResult>>;
  running: N | null;
}

export default function CheckList<N extends string = CheckName>({ items, results, running }: Props<N>) {
  return (
    <ul className="check-list">
      {items.map(({ name, label, showOkDetail }) => {
        const result: CheckRowResult | undefined = results[name];
        return (
          <li key={name} className="check-row">
            <span className="check-mark">
              {running === name && !result && (
                <span className="check-spinner" role="status" aria-label="checking" />
              )}
              {result?.state === 'ok' && (
                <svg className="check-ok" viewBox="0 0 20 20" role="img" aria-label="passed"
                     fill="none" stroke="currentColor" strokeWidth="2.4"
                     strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 10.5l4 4 8-9" />
                </svg>
              )}
              {result && result.state !== 'ok' && (
                <svg className="check-fail" viewBox="0 0 20 20" role="img" aria-label="failed"
                     fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                  <path d="M5 5l10 10M15 5L5 15" />
                </svg>
              )}
              {running !== name && !result && <span className="check-dot" aria-hidden="true" />}
            </span>
            <span>{label}</span>
            {result && result.state !== 'ok' && result.detail && (
              <span className="form-error">{result.detail}</span>
            )}
            {result?.state === 'ok' && showOkDetail && result.detail && (
              <span className="check-note">{result.detail}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
