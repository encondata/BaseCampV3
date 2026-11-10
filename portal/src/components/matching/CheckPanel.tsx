/** The selected version's check: each structure item ✓ or ✗ (what's wrong
 *  listed under a ✗), today's test-set result, and the result the version
 *  got when it was last checked. */

import { useId } from 'react';

import type { MatchingCheck, MatchingVersion } from '../../lib/api';
import { formatSavedAt } from '../../lib/matchingRules';

export default function CheckPanel({ version, check }: {
  version: MatchingVersion | null; check: MatchingCheck | null;
}) {
  const titleId = useId();
  if (!version) return null;
  return (
    <section className="mr-panel mr-scroll" aria-labelledby={titleId}>
      <h2 className="mr-panel-title" id={titleId}>Check · v{version.version}</h2>
      {!check ? (
        <p className="page-hint">Loading…</p>
      ) : (
        <>
          <ul className="mr-check">
            {check.structure.map((item) => (
              <li key={item.code} className={item.ok ? 'is-ok' : 'is-bad'}>
                <span className="mr-check-mark" aria-hidden="true">{item.ok ? '✓' : '✗'}</span>
                <span className="sr-only">{item.ok ? 'Passes: ' : 'Fails: '}</span>
                {item.label}
                {!item.ok && item.problems.length > 0 && (
                  <ul className="mr-problems">
                    {item.problems.map((p, i) => <li key={i}>{p.message}</li>)}
                  </ul>
                )}
              </li>
            ))}
          </ul>
          <p className="mr-check-sum">
            {check.total === 0
              ? 'Test set: no rows for this place yet'
              : `Test set: ${check.passed} of ${check.total}`}
          </p>
          {version.checked && (
            <p className="mr-check-sum is-muted">
              Checked {formatSavedAt(version.checked.checked_at)}: {version.checked.passed} of {version.checked.total}
            </p>
          )}
        </>
      )}
    </section>
  );
}
