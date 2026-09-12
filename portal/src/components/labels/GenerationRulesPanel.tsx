/**
 * Generation rules — V2's `label_generation_code` port. The label
 * worker splits a raw destination/source location string on "." by
 * 1-based position into extra placeholder tokens (e.g. position 2 in
 * "R12.3.B" → {row} = "3"), plus per-token length limits that truncate a
 * substituted value before it lands on the label. A pure controlled rows
 * editor: `LabelTemplateEditor` owns the row state (loaded once from the
 * template's `generation_rules`, converted back at save time), this
 * component only renders inputs and bubbles edits up via onChange.
 */
import {
  isValidToken, validateRuleRows,
  type GenerationRulesRows, type LimitRuleRow, type PositionRuleRow,
} from '../../lib/generateLabels';

function PositionRows({ title, hint, rows, onChange }: {
  title: string; hint: string; rows: PositionRuleRow[]; onChange: (rows: PositionRuleRow[]) => void;
}) {
  const update = (i: number, patch: Partial<PositionRuleRow>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => onChange(rows.filter((_, idx) => idx !== i));
  const add = () => onChange([...rows, { position: '', token: '' }]);

  return (
    <div className="lbl-rules-group">
      <div className="modal-section">{title}</div>
      <p className="page-hint">{hint}</p>
      {rows.map((r, i) => {
        const badToken = r.token.trim() !== '' && !isValidToken(r.token.trim());
        return (
          <div className="lbl-rules-line" key={i}>
            <input aria-label={`${title} position`} className="mono lbl-rules-pos"
                   placeholder="Pos" value={r.position}
                   onChange={(e) => update(i, { position: e.target.value })} />
            <span className="lbl-rules-arrow" aria-hidden="true">→</span>
            <input aria-label={`${title} token`} className={`mono ${badToken ? 'lbl-rules-bad' : ''}`}
                   placeholder="token_name" value={r.token}
                   onChange={(e) => update(i, { token: e.target.value })} />
            <button type="button" className="mini-btn" aria-label={`Remove ${title.toLowerCase()} rule`}
                    onClick={() => remove(i)}>✕</button>
          </div>
        );
      })}
      <button type="button" className="mini-btn accent" onClick={add}>+ Add position</button>
    </div>
  );
}

function LimitRows({ rows, onChange }: {
  rows: LimitRuleRow[]; onChange: (rows: LimitRuleRow[]) => void;
}) {
  const update = (i: number, patch: Partial<LimitRuleRow>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => onChange(rows.filter((_, idx) => idx !== i));
  const add = () => onChange([...rows, { token: '', limit: '' }]);

  return (
    <div className="lbl-rules-group">
      <div className="modal-section">Length limits</div>
      <p className="page-hint">Truncate a substituted value's length before it's placed on the label.</p>
      {rows.map((r, i) => {
        const badToken = r.token.trim() !== '' && !isValidToken(r.token.trim());
        return (
          <div className="lbl-rules-line" key={i}>
            <input aria-label="Length limit token" className={`mono ${badToken ? 'lbl-rules-bad' : ''}`}
                   placeholder="token_name" value={r.token}
                   onChange={(e) => update(i, { token: e.target.value })} />
            <span className="lbl-rules-arrow" aria-hidden="true">≤</span>
            <input aria-label="Length limit" type="number" min={1} className="mono lbl-rules-pos"
                   placeholder="20" value={r.limit}
                   onChange={(e) => update(i, { limit: e.target.value })} />
            <button type="button" className="mini-btn" aria-label="Remove length limit"
                    onClick={() => remove(i)}>✕</button>
          </div>
        );
      })}
      <button type="button" className="mini-btn accent" onClick={add}>+ Add length limit</button>
    </div>
  );
}

export default function GenerationRulesPanel({ rows, onChange }: {
  rows: GenerationRulesRows;
  onChange: (rows: GenerationRulesRows) => void;
}) {
  const error = validateRuleRows(rows);

  return (
    <div className="lbl-rules-panel">
      <span className="eyebrow-sm">Generation rules</span>
      <p className="page-hint">
        Split a location string like &quot;R12.3.B&quot; into extra tokens by position (1-based) for
        this template&apos;s placeholders, and cap how long a value may be before it&apos;s placed.
      </p>
      <PositionRows title="Destination" hint="Position in the destination location string → token name."
                    rows={rows.destination} onChange={(destination) => onChange({ ...rows, destination })} />
      <PositionRows title="Source" hint="Position in the source location string → token name."
                    rows={rows.source} onChange={(source) => onChange({ ...rows, source })} />
      <LimitRows rows={rows.lengthLimits} onChange={(lengthLimits) => onChange({ ...rows, lengthLimits })} />
      {error && <p className="pf-error">{error}</p>}
    </div>
  );
}
