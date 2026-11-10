/** Deploy, Roll back to, or Save as standby: says what will happen, then
 *  makes the change. A version that fails the check stays put: the dialog
 *  says so and stays open, and the page fills its check panel from the
 *  refusal's `check` (onCheckFailed). */

import { useState } from 'react';

import {
  ApiError, deployMatchingVersion, rollbackMatchingVersion, standbyMatchingVersion,
  type MatchingCheck, type MatchingVersion,
} from '../../lib/api';
import StandardModal from '../StandardModal';
import '../../styles/profile.css'; /* .btn-solid, .pf-error */
import '../../styles/directory.css'; /* .mini-btn */
import '../../styles/matching-rules.css';

export type StateChangeKind = 'deploy' | 'rollback' | 'standby';

function copyFor(kind: StateChangeKind, n: number, liveVersion: number | null, placeLabel: string) {
  const retired = liveVersion !== null && liveVersion !== n ? `, and v${liveVersion} is retired` : '';
  if (kind === 'deploy') {
    return { title: `Deploy v${n}`, hint: `v${n} becomes the live ${placeLabel} flow${retired}.`, button: 'Deploy' };
  }
  if (kind === 'rollback') {
    return {
      title: `Roll back to v${n}`,
      hint: `v${n} becomes the live ${placeLabel} flow again${retired}.`,
      button: 'Roll back',
    };
  }
  return { title: `Save v${n} as standby`, hint: `v${n} is checked and kept ready, but not live.`, button: 'Save as standby' };
}

const CALL = { deploy: deployMatchingVersion, rollback: rollbackMatchingVersion, standby: standbyMatchingVersion };

export default function StateChangeModal({
  kind, version, liveVersion, placeLabel, onClose, onDone, onCheckFailed,
}: {
  kind: StateChangeKind;
  version: MatchingVersion;
  liveVersion: number | null;
  placeLabel: string;
  onClose: () => void;
  onDone: () => void;
  onCheckFailed?: (check: MatchingCheck) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const copy = copyFor(kind, version.version, liveVersion, placeLabel);

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      await CALL[kind](version.id);
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'check_failed') {
        setError(`v${version.version} doesn't pass the check. The check panel shows what's wrong.`);
        const check = (err.detail as { check?: MatchingCheck } | undefined)?.check;
        if (check) onCheckFailed?.(check);
      } else {
        setError(`Couldn't change v${version.version}. Try again.`);
      }
      setBusy(false);
    }
  };

  return (
    <StandardModal eyebrow="Matching rules" title={copy.title} description={copy.hint} cardClass="mr-confirm-card"
      busy={busy} onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn-solid" disabled={busy} onClick={() => void run()}>
            {copy.button}
          </button>
          <button type="button" className="mini-btn" disabled={busy} onClick={onClose}>Cancel</button>
        </>
      )}
    >
      {error ? <p className="pf-error" role="alert">{error}</p> : null}
    </StandardModal>
  );
}
