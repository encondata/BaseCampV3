/** MacroPoint tab of Manual update: add emails (.eml files and/or pasted
 *  text) → review each load and its truck → apply → summary. The server
 *  parses twice (preview, then apply) from the same input; the panel keeps
 *  the files and text so Back and a failed apply lose nothing. */
import { Fragment, useMemo, useRef, useState } from 'react';

import {
  ApiError, applyMacroPoint, previewMacroPoint,
  type MacroPointApplyResult, type MacroPointGroup, type MacroPointPreview,
} from '../../lib/api';
import {
  MACROPOINT_ERRORS, assignmentsPayload, initialAssignments, isEml, reasonText, truckOptions,
} from '../../lib/macropoint';
import ComboBox from '../ComboBox';
import DataTable from '../DataTable';
import MultiFileDropzone from '../MultiFileDropzone';
import MacroPointSummary from './MacroPointSummary';

type Step = 'input' | 'review' | 'summary';
const STEPS: { key: Step; label: string }[] = [
  { key: 'input', label: 'Add emails' }, { key: 'review', label: 'Review' }, { key: 'summary', label: 'Summary' },
];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function matchHint(g: MacroPointGroup): string {
  if (g.match.by === 'order') return 'Matched by MacroPoint order';
  if (g.match.by === 'tracker_id') return 'Matched by tracking name';
  if (g.match.ambiguous_ids.length) return 'Several trucks match — pick one';
  return 'No match — pick a truck or leave blank to skip';
}

function errorText(err: unknown): string {
  return err instanceof ApiError
    ? (MACROPOINT_ERRORS[err.code] ?? 'Could not reach the server — try again.')
    : 'Could not reach the server — try again.';
}

interface Props { onClose: () => void; onApplied: () => void; onBusy: (busy: boolean) => void }

export default function MacroPointPanel({ onClose, onApplied, onBusy }: Props) {
  const [step, setStep] = useState<Step>('input');
  const [files, setFiles] = useState<File[]>([]);
  const [text, setText] = useState('');
  const [rejected, setRejected] = useState<string[]>([]);
  const [preview, setPreview] = useState<MacroPointPreview | null>(null);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [result, setResult] = useState<MacroPointApplyResult | null>(null);
  const [busy, setBusyState] = useState<'parse' | 'apply' | null>(null);
  const [error, setError] = useState('');
  // MultiFileDropzone reports a mixed drop as onRejected(bad) THEN
  // onFiles(ok) in the same call; this flag stops that onFiles from
  // clearing the names just reported. Reset on the next microtask so a
  // later add or remove clears the stale list as usual.
  const justRejected = useRef(false);
  const onRejected = (names: string[]) => {
    setRejected(names);
    justRejected.current = true;
    queueMicrotask(() => { justRejected.current = false; });
  };
  const onFiles = (f: File[]) => {
    setFiles(f);
    if (!justRejected.current) setRejected([]);
  };

  const setBusy = (b: 'parse' | 'apply' | null) => { setBusyState(b); onBusy(b !== null); };
  const current = STEPS.findIndex((s) => s.key === step);

  const totals = useMemo(() => {
    const groups = preview?.groups ?? [];
    return {
      loads: groups.length,
      fresh: groups.reduce((n, g) => n + g.new, 0),
      dupes: groups.reduce((n, g) => n + g.duplicates, 0),
      problems: preview?.errors.length ?? 0,
    };
  }, [preview]);
  const canApply = (preview?.groups ?? []).some((g) => chosen[g.group_key] && g.new > 0);

  const parse = async () => {
    setBusy('parse');
    setError('');
    try {
      const p = await previewMacroPoint(files, text);
      setPreview(p);
      setChosen(initialAssignments(p));
      setStep('review');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!preview) return;
    setBusy('apply');
    setError('');
    try {
      setResult(await applyMacroPoint(files, text, assignmentsPayload(preview.groups, chosen)));
      setStep('summary');
      onApplied();   // the trucks changed — reload behind the summary, however the dialog closes
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="rgm-steps">
        {STEPS.map((s, i) => (
          <Fragment key={s.key}>
            {i > 0 && <span className="rgm-step-sep" />}
            <span className={`rgm-step ${i === current ? 'on' : ''} ${i < current ? 'done' : ''}`}
                  aria-current={i === current ? 'step' : undefined}>
              <span className="rgm-step-num">{i + 1}</span>
              <span className="rgm-step-label">{s.label}</span>
            </span>
          </Fragment>
        ))}
      </div>

      <div className="modal-body">
        {step === 'input' && (
          <div className="mp-input">
            <MultiFileDropzone files={files} onFiles={onFiles}
                               busy={busy !== null} accept=".eml" filter={isEml}
                               onRejected={onRejected}
                               hint="MacroPoint emails saved as .eml files" />
            {rejected.length > 0 && (
              <p className="pf-error">Skipped (not .eml): {rejected.join(', ')}</p>
            )}
            <div className="pf-form">
              <div className="full">
                <label htmlFor="mp-paste">Or paste email text</label>
                <textarea id="mp-paste" aria-label="Pasted email text" rows={8} value={text}
                          disabled={busy !== null} onChange={(e) => setText(e.target.value)}
                          placeholder="Paste one or more MacroPoint emails here" />
              </div>
            </div>
          </div>
        )}

        {step === 'review' && preview && (
          <div className="mp-review">
            <p className="set-note">
              {plural(totals.loads, 'load', 'loads')} · {totals.fresh} new · {totals.dupes} already recorded
              {totals.problems > 0 && ` · ${plural(totals.problems, 'problem', 'problems')}`}
            </p>
            {preview.groups.map((g) => (
              <section key={g.group_key} className="mp-group">
                <div className="mp-group-top">
                  <div className="mp-group-id">
                    <b>{g.id_number}</b>
                    <span className="set-note">{g.carrier} · {g.new} new · {g.duplicates} already recorded</span>
                  </div>
                  <div className="mp-group-truck">
                    <ComboBox
                      ariaLabel={`Truck for ${g.id_number}`}
                      placeholder="Pick a truck…"
                      clearable
                      disabled={busy !== null}
                      value={chosen[g.group_key] ?? ''}
                      onChange={(v) => setChosen((c) => ({ ...c, [g.group_key]: v }))}
                      options={truckOptions(preview.trucks, g.match.ambiguous_ids)}
                    />
                    <span className="set-note">{matchHint(g)}</span>
                  </div>
                </div>
                <DataTable
                  ariaLabel={`Updates for ${g.id_number}`}
                  className="bulk-preview"
                  columns={[
                    { key: 'when', label: 'When', mono: true },
                    { key: 'update', label: 'Update' },
                    { key: 'address', label: 'Address' },
                    { key: 'status', label: 'Status' },
                  ]}
                  rows={g.rows.map((r, i) => ({
                    key: `${i}`,
                    className: r.duplicate ? 'mp-dup' : undefined,
                    cells: [
                      new Date(r.recorded_at).toLocaleString(),
                      `${r.location ?? r.event ?? ''}${r.duplicate ? ' · Already recorded' : ''}`,
                      r.address || '—',
                      r.status_to_label ? `→ ${r.status_to_label}` : '',
                    ],
                  }))}
                />
              </section>
            ))}
            {preview.errors.length > 0 && (
              <section className="mp-group">
                <div className="modal-section">Problems</div>
                <DataTable
                  ariaLabel="Problems"
                  columns={[{ key: 'source', label: 'Source' }, { key: 'reason', label: 'Problem' }]}
                  rows={preview.errors.map((e, i) => ({
                    key: `${i}`, cells: [e.source, reasonText(e.reason)],
                  }))}
                />
              </section>
            )}
          </div>
        )}

        {step === 'summary' && result && <MacroPointSummary result={result} />}
      </div>

      <div className="modal-foot">
        {step === 'input' && (
          <>
            <button className="btn-solid" disabled={busy !== null || (!files.length && !text.trim())}
                    onClick={() => void parse()}>
              {busy === 'parse' ? 'Parsing…' : 'Parse'}
            </button>
            <button className="mini-btn" disabled={busy !== null} onClick={onClose}>Cancel</button>
          </>
        )}
        {step === 'review' && (
          <>
            <button className="btn-solid" disabled={busy !== null || !canApply}
                    onClick={() => void apply()}>
              {busy === 'apply' ? 'Applying…' : 'Apply'}
            </button>
            <button className="mini-btn" disabled={busy !== null} onClick={() => setStep('input')}>Back</button>
          </>
        )}
        {step === 'summary' && (
          <button className="btn-solid" onClick={onClose}>Done</button>
        )}
        {error && <span className="pf-error">{error}</span>}
      </div>
    </>
  );
}
