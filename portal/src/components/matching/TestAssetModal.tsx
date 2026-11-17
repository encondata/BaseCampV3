/** Add or edit one test asset and its expected results. Save writes the
 *  asset first, then brings its rows in line with the list: removed rows
 *  are deleted, changed ones updated, new ones created. A refusal stops
 *  there and says why; what was already written stays written, so the next
 *  Save carries on from it (and Cancel still reloads the page's list).
 *
 *  Also here: DeleteTestAssetModal, the confirm step for deleting one. */

import { useRef, useState } from 'react';

import ComboBox from '../ComboBox';
import {
  ApiError,
  createMatchingTestAsset, createMatchingTestRow, deleteMatchingTestAsset, deleteMatchingTestRow,
  updateMatchingTestAsset, updateMatchingTestRow,
  type MatchingPlace, type MatchingTestAsset, type MatchingTestAssetIn, type MatchingTestRow,
} from '../../lib/api';
import { EXPECTED_LABELS, PLACES } from '../../lib/matchingRules';
import StandardModal from '../StandardModal';
import '../../styles/profile.css'; /* .btn-solid, .pf-form, .pf-error */
import '../../styles/directory.css'; /* .btn-danger, .mini-btn */
import '../../styles/matching-rules.css';

interface Line {
  key: string;
  id: string | null;
  place: MatchingPlace;
  value: string;
  expected: string;
}

const PLACE_OPTIONS = PLACES.map((p) => ({ value: p.key, label: p.label }));
const EXPECTED_OPTIONS = EXPECTED_LABELS.map((e) => ({ value: e.key, label: e.label }));
const placeLabel = (key: string): string => PLACES.find((p) => p.key === key)?.label ?? key;
const SITS: { key: 'move' | 'client'; label: string }[] = [
  { key: 'move', label: 'On the move' },
  { key: 'client', label: "Client's other device" },
];

const lineOf = (r: MatchingTestRow): Line => ({
  key: r.id, id: r.id, place: r.place, value: r.value, expected: r.expected,
});

export default function TestAssetModal({ asset, onClose, onSaved }: {
  asset: MatchingTestAsset | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [tag, setTag] = useState(asset ? String(asset.asset_tag) : '');
  const [name, setName] = useState(asset?.name ?? '');
  const [rfid, setRfid] = useState(asset?.rfid ?? '');
  const [serial, setSerial] = useState(asset?.serial ?? '');
  const [sits, setSits] = useState<'move' | 'client'>(asset?.sits ?? 'move');
  const [lines, setLines] = useState<Line[]>(() => (asset?.rows ?? []).map(lineOf));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // What the server holds now, as this dialog has written it.
  const saved = useRef<MatchingTestAsset | null>(asset);
  const serverRows = useRef(new Map((asset?.rows ?? []).map((r) => [r.id, r])));
  const wrote = useRef(false);
  const nextKey = useRef(0);

  const tagOk = /^\d+$/.test(tag.trim()) && Number(tag) >= 1;
  const canSave = tagOk && name.trim() !== '' && lines.every((l) => l.value.trim() !== '');

  const setLine = (key: string, patch: Partial<Line>) =>
    setLines((cur) => cur.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const addLine = () => {
    nextKey.current += 1;
    setLines((cur) => [...cur, {
      key: `new-${nextKey.current}`, id: null, place: 'printing', value: '', expected: 'asset_tag',
    }]);
  };

  const save = async () => {
    setBusy(true);
    setError('');
    const work = lines.map((l) => ({ ...l }));
    let failing: Line | null = null;
    try {
      const body: MatchingTestAssetIn = {
        asset_tag: Number(tag),
        name: name.trim(),
        rfid: rfid.trim() || null,
        serial: serial.trim() || null,
        sits,
      };
      const current = saved.current
        ? await updateMatchingTestAsset(saved.current.id, body)
        : await createMatchingTestAsset(body);
      saved.current = current;
      wrote.current = true;

      const kept = new Set(work.map((l) => l.id).filter(Boolean));
      for (const id of [...serverRows.current.keys()]) {
        if (kept.has(id)) continue;
        await deleteMatchingTestRow(id);
        serverRows.current.delete(id);
      }
      for (const l of work) {
        const rowBody = { place: l.place, value: l.value, expected: l.expected };
        failing = l;
        if (l.id) {
          const was = serverRows.current.get(l.id);
          if (was && was.place === l.place && was.value === l.value && was.expected === l.expected) continue;
          serverRows.current.set(l.id, await updateMatchingTestRow(l.id, rowBody));
        } else {
          const row = await createMatchingTestRow(current.id, rowBody);
          l.id = row.id;
          serverRows.current.set(row.id, row);
        }
      }
      failing = null;
      onSaved();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : '';
      if (code === 'duplicate_asset_tag') setError(`Another test asset has asset tag ${Number(tag)}.`);
      else if (code === 'duplicate_value' && failing) {
        setError(`${placeLabel(failing.place)} already has an expected result for "${failing.value}".`);
      } else if (code === 'test_set_full') setError('The test set holds at most 10 assets.');
      else setError("Couldn't save the test asset. Try again.");
      setLines(work);
      setBusy(false);
    }
  };

  const cancel = () => (wrote.current ? onSaved() : onClose());

  return (
    <StandardModal
      eyebrow="Matching rules"
      title={asset ? 'Edit test asset' : 'Add test asset'}
      description="An asset the check runs every version against, and what each place should find for it."
      cardClass="mr-asset-card" busy={busy} onClose={cancel}
      footer={(
        <>
          <button type="button" className="btn-solid" disabled={!canSave || busy} onClick={() => void save()}>
            Save
          </button>
          <button type="button" className="mini-btn" disabled={busy} onClick={cancel}>Cancel</button>
        </>
      )}
    >
      <div className="pf-form">
        <div>
          <label htmlFor="mr-asset-tag">Asset tag</label>
          <input id="mr-asset-tag" type="number" min={1} step={1} value={tag} disabled={busy}
                 onChange={(e) => setTag(e.target.value)} />
        </div>
        <div>
          <label htmlFor="mr-asset-name">Name</label>
          <input id="mr-asset-name" value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label htmlFor="mr-asset-rfid">RFID</label>
          <input id="mr-asset-rfid" value={rfid} disabled={busy} onChange={(e) => setRfid(e.target.value)} />
        </div>
        <div>
          <label htmlFor="mr-asset-serial">Serial</label>
          <input id="mr-asset-serial" value={serial} disabled={busy} onChange={(e) => setSerial(e.target.value)} />
        </div>
        <div className="full">
          <label id="mr-asset-sits">Where it sits</label>
          <div className="segmented" role="group" aria-labelledby="mr-asset-sits">
            {SITS.map((s) => (
              <button key={s.key} type="button" className={sits === s.key ? 'on' : ''} aria-pressed={sits === s.key}
                      disabled={busy} onClick={() => setSits(s.key)}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="modal-section">Expected results</div>
      {lines.length > 0 && (
        <div className="mr-expected">
          <div className="mr-expected-labels" aria-hidden="true">
            <span>Place</span><span>Value to try</span><span>Should find</span><span />
          </div>
          {lines.map((l) => (
            <div key={l.key} className="mr-expected-line pf-form">
              <ComboBox ariaLabel="Place" options={PLACE_OPTIONS} value={l.place} disabled={busy}
                        onChange={(v) => { if (v) setLine(l.key, { place: v as MatchingPlace }); }} />
              <input aria-label="Value to try" value={l.value} disabled={busy}
                     onChange={(e) => setLine(l.key, { value: e.target.value })} />
              <ComboBox ariaLabel="Should find" options={EXPECTED_OPTIONS} value={l.expected} disabled={busy}
                        onChange={(v) => { if (v) setLine(l.key, { expected: v }); }} />
              <button type="button" className="mini-btn" disabled={busy}
                      onClick={() => setLines((cur) => cur.filter((x) => x.key !== l.key))}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      <button type="button" className="mini-btn" disabled={busy} onClick={addLine}>Add expected result</button>
      {error && <p className="pf-error mr-modal-error" role="alert">{error}</p>}
    </StandardModal>
  );
}

export function DeleteTestAssetModal({ asset, onClose, onDone }: {
  asset: MatchingTestAsset;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      await deleteMatchingTestAsset(asset.id);
      onDone();
    } catch {
      setError(`Couldn't delete test asset ${asset.asset_tag}. Try again.`);
      setBusy(false);
    }
  };

  return (
    <StandardModal
      eyebrow="Matching rules"
      title={`Delete test asset ${asset.asset_tag}`}
      description="Its expected results are deleted with it."
      cardClass="mr-confirm-card" busy={busy} onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn-solid btn-danger" disabled={busy} onClick={() => void run()}>
            Delete
          </button>
          <button type="button" className="mini-btn" disabled={busy} onClick={onClose}>Cancel</button>
        </>
      )}
    >
      {error ? <p className="pf-error" role="alert">{error}</p> : null}
    </StandardModal>
  );
}
