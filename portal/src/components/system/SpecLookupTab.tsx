/** Spec lookup tab: read-only view of the makes/models spec-lookup
 *  configuration (model, per-model search/fetch caps, masked API key,
 *  worker health) plus a Test connection button. Values are set via the
 *  Environment tab; this tab never writes anything. */

import { useCallback, useEffect, useState } from 'react';

import { getSpecLookupDev, testSpecLookup, type SpecLookupDev } from '../../lib/api';
import { relativeTime } from '../../lib/format';

export default function SpecLookupTab() {
  const [dev, setDev] = useState<SpecLookupDev | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded = await getSpecLookupDev();
        if (!cancelled) setDev(loaded);
      } catch {
        if (!cancelled) setLoadError('Could not load the spec lookup configuration.');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const test = useCallback(async () => {
    setTestBusy(true);
    setTestResult(null);
    try {
      const result = await testSpecLookup();
      if (result.ok) {
        setTestResult({ ok: true, text: `Connected in ${result.latency_ms} ms` });
      } else {
        setTestResult({ ok: false, text: result.error ?? 'Test failed.' });
      }
    } catch {
      setTestResult({ ok: false, text: 'Could not run the test.' });
    } finally {
      setTestBusy(false);
    }
  }, []);

  if (loadError) {
    return <div className="dir-empty" style={{ marginTop: 16 }}><b>{loadError}</b></div>;
  }

  if (!dev) {
    return <p className="page-hint">Loading…</p>;
  }

  return (
    <div className="sysconf-tab-body">
      <div className="init-panel sysconf-card">
        <div className="sysconf-card-head">
          <p className="eyebrow-sm">Configuration</p>
          <p className="sysconf-card-desc">Current makes/models spec lookup settings.</p>
        </div>
        <dl className="kv">
          <dt>Model</dt><dd className="mono">{dev.model}</dd>
          <dt>Max searches per model</dt><dd>{dev.max_searches}</dd>
          <dt>Max page reads per model</dt><dd>{dev.max_fetches}</dd>
          <dt>API key</dt>
          <dd>{dev.key_set ? `Set (…${dev.key_last4 ?? '????'})` : 'Not set'}</dd>
          <dt>Worker</dt>
          <dd>
            {dev.worker_status}
            {dev.worker_heartbeat_at && ` (last heartbeat ${relativeTime(dev.worker_heartbeat_at)})`}
          </dd>
        </dl>
      </div>

      <p className="page-hint">
        Set these in the Environment tab (SS_ANTHROPIC_API_KEY, SS_SPEC_LOOKUP_*); the API and
        worker pick up changes after a restart.
      </p>

      <div className="sysconf-actionbar">
        <button type="button" className="mini-btn" disabled={testBusy} onClick={() => void test()}>
          {testBusy ? 'Testing…' : 'Test connection'}
        </button>
        <span className="sysconf-actionbar-status">
          {testResult && (
            testResult.ok
              ? <span className="set-ok">{testResult.text}</span>
              : <span className="pf-error">{testResult.text}</span>
          )}
        </span>
      </div>
    </div>
  );
}
