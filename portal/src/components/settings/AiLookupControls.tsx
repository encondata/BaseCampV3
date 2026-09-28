/**
 * AiLookupControls — System settings › AI lookup. Controls the Makes /
 * Models spec lookup (Claude web search): the background sweep, auto-apply
 * of verified values into BLANK fields, the lookup effort (thinking depth
 * and searches per model), which field groups are asked for, and how long
 * before a looked-up model is tried again.
 */
import { Fragment, useEffect, useState } from 'react';

import {
  ApiError, getAiLookupConfig, updateAiLookupConfig, type AiLookupConfig, type AiLookupEffort,
} from '../../lib/api';
import { Switch } from '../Switch';

type ToggleKey = 'background_enabled' | 'auto_apply' | 'fields_specs' | 'fields_mounting' | 'fields_knowledge';

const EFFORTS: [AiLookupEffort, string][] = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];

const ROWS: { key: ToggleKey; title: string; hint: string }[] = [
  { key: 'background_enabled', title: 'Background search',
    hint: 'Look up models with missing details automatically, one at a time. Models marked Private or Skip are never sent.' },
  { key: 'auto_apply', title: 'Auto-apply confident matches',
    hint: 'Verified values fill blank fields right away and show as Applied with Undo. Existing values are never overwritten; knowledge notes always wait for review.' },
  { key: 'fields_specs', title: 'Specs', hint: 'RU size, weight, and dimensions.' },
  { key: 'fields_mounting', title: 'Mounting', hint: 'Mount type and rail type.' },
  { key: 'fields_knowledge', title: 'Knowledge', hint: 'A short note on what the product is, for the Field knowledge box.' },
];

export default function AiLookupControls({ canChange = true }: { canChange?: boolean }) {
  const [cfg, setCfg] = useState<AiLookupConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [days, setDays] = useState('');

  useEffect(() => {
    void getAiLookupConfig()
      .then((c) => { setCfg(c); setDays(String(c.retry_after_days)); })
      .catch(() => setError('Could not load AI lookup settings.'));
  }, []);

  const patch = async (p: Partial<AiLookupConfig>) => {
    setBusy(true); setError('');
    try {
      const next = await updateAiLookupConfig(p);
      setCfg(next); setDays(String(next.retry_after_days));
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Could not save.'); }
    finally { setBusy(false); }
  };

  const locked = busy || !canChange || cfg === null;
  const saveDays = () => {
    const n = Number(days);
    if (!cfg || !Number.isInteger(n) || n < 0 || n === cfg.retry_after_days) {
      if (cfg) setDays(String(cfg.retry_after_days));
      return;
    }
    void patch({ retry_after_days: n });
  };

  return (
    <>
      {ROWS.map((r) => (
        <Fragment key={r.key}>
          <div className="set-row">
            <div className="set-label"><b>{r.title}</b><span>{r.hint}</span></div>
            <Switch checked={Boolean(cfg?.[r.key])} disabled={locked}
                    onChange={(v) => void patch({ [r.key]: v } as Partial<AiLookupConfig>)} />
          </div>
          {r.key === 'auto_apply' && (
            <div className="set-row">
              <div className="set-label">
                <b>Lookup effort</b>
                <span>How hard Claude thinks and how many web searches it may run per model. Low: 1 search. Medium: 2 searches. High: 4 searches, for hard-to-find models — costs more.</span>
              </div>
              <div className="segmented" role="group" aria-label="Lookup effort">
                {EFFORTS.map(([value, label]) => (
                  <button key={value} type="button" aria-pressed={cfg?.effort === value}
                          className={cfg?.effort === value ? 'on' : ''} disabled={locked}
                          onClick={() => { if (cfg?.effort !== value) void patch({ effort: value }); }}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </Fragment>
      ))}
      <div className="set-row">
        <div className="set-label">
          <b>Retry after</b>
          <span>Days before a model that was already looked up is tried again by the background search. 0 means never; "Look up specs" on a model always runs.</span>
        </div>
        <input aria-label="Retry after (days)" type="number" min={0} max={3650} style={{ width: 90 }}
               value={days} disabled={locked}
               onChange={(e) => setDays(e.target.value)} onBlur={saveDays}
               onKeyDown={(e) => { if (e.key === 'Enter') saveDays(); }} />
      </div>
      {error && <p className="pf-error" style={{ margin: '0 20px 14px' }}>{error}</p>}
    </>
  );
}
