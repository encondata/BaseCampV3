/**
 * Rows for the RFID connectivity checks (Network check, and the final
 * check): a spinner while a row runs, a green check when it passed, a red
 * X with its detail when it failed, a muted dot until it has run.
 */

import type { CheckName, CheckResult } from '../../lib/api';

interface Props {
  items: { name: CheckName; label: string }[];
  results: Partial<Record<CheckName, CheckResult>>;
  running: CheckName | null;
}

export default function CheckList({ items, results, running }: Props) {
  return (
    <ul className="check-list">
      {items.map(({ name, label }) => {
        const result = results[name];
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
          </li>
        );
      })}
    </ul>
  );
}
