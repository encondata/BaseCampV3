/**
 * ColorField — a true colour picker for vocabulary rows (status values,
 * site types, worker levels): the OS colour picker, a hex text field, the
 * seven starter swatches, and a live dual-theme preview.
 *
 * One stored hex has to read correctly on both themes, and it can't do that
 * unverbatim — see the "vocabulary colour" rule in styles/directory.css.
 * The preview below renders the real shape through that real rule (nesting a
 * genuine `.portal-shell[data-theme='dark']`) rather than approximating it,
 * so picking a colour never surprises: what's shown is what renders. Which
 * shape depends on the caller: statuses and site types render as `.chip`
 * (colour as text on a tint of itself); worker levels render as
 * `.lvl-badge b` (colour as the background under fixed near-black text) —
 * the opposite clamp, so previewing the wrong shape actively lies.
 */

import {
  useEffect, useId, useState,
  type ChangeEvent, type CSSProperties, type FocusEvent, type KeyboardEvent,
} from 'react';

import { normalizeHex, PRESET_COLORS } from '../../lib/variables';

interface Props {
  value: string;
  onChange: (hex: string) => void;
  disabled?: boolean;
  shape?: 'chip' | 'badge';
  // Badge shape only: the text shown inside the swatch (a level's `L1`-style
  // key). Falls back to something neutral when the caller has none yet
  // (create mode, before a key is typed).
  sample?: string;
}

export default function ColorField({ value, onChange, disabled, shape = 'chip', sample }: Props) {
  const hexId = useId();
  // Local, editable copy of the text field — the source of truth while the
  // user is typing. Only normalizeHex'd and pushed up to the parent on
  // commit (blur or Enter), and re-synced from `value` when the parent
  // changes it out from under us (a swatch click, the native picker, or an
  // external reset).
  const [text, setText] = useState(value);
  // Set when a commit attempt (blur or Enter) couldn't parse `text` as a
  // hex colour. Surfaced as an inline hint rather than swallowed silently —
  // onChange is NOT called in that case, so the stored colour, the preview
  // and the swatches all keep showing the last valid value while the text
  // field itself still shows what the user typed.
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    setText(value);
  }, [value]);

  const commit = (raw: string) => {
    const normalized = normalizeHex(raw);
    if (!normalized) {
      setInvalid(true);   // junk: leave exactly what the user typed, but say so
      return;
    }
    setInvalid(false);
    setText(normalized);
    onChange(normalized);
  };

  const commitHex = (e: FocusEvent<HTMLInputElement>) => commit(e.target.value);

  // Enter implicitly submits the enclosing form (the only `<button>` in
  // these modals is `type="submit"`), which never fires blur — without this
  // the modal saves whatever `value` still holds, silently discarding a
  // freshly typed hex. preventDefault stops that submit; committing first is
  // the point of intercepting the key at all.
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    commit(e.currentTarget.value);
  };

  // Set only the property this shape's rule reads. Setting both was inert —
  // neither rule reads the other's — but it invited the reader to think a chip
  // and a badge are interchangeable, and they are the opposite of that: a chip
  // clamps its text per theme, a badge clamps its background in both.
  const swatchStyle: CSSProperties = shape === 'badge'
    ? ({ '--lvl': value } as CSSProperties)
    : ({ '--chip': value } as CSSProperties);
  const sampleLabel = sample && sample.trim() !== '' ? sample : '—';

  // Identical in both halves — only the shell around it differs, which is the
  // entire point: one colour, rendered by the real rule under each theme.
  const preview = shape === 'badge'
    ? <span className="lvl-badge"><b style={swatchStyle}>{sampleLabel}</b></span>
    : <span className="chip custom" style={swatchStyle}><span className="dot" />Preview</span>;

  return (
    <div className="cf">
      <div className="cf-row">
        <input
          type="color"
          className="cf-native"
          aria-label="Pick a color"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
        <div className="cf-hex-wrap">
          <label htmlFor={hexId}>Hex</label>
          <input
            id={hexId}
            className="cf-hex"
            type="text"
            value={text}
            disabled={disabled}
            aria-invalid={invalid}
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              setText(e.target.value);
              setInvalid(false);   // give the hint back once they start correcting it
            }}
            onBlur={commitHex}
            onKeyDown={handleKeyDown}
          />
          {invalid && <p className="pf-error" style={{ margin: '6px 0 0' }}>Not a valid hex colour.</p>}
        </div>
      </div>

      <div className="cf-swatches">
        {PRESET_COLORS.map((p) => (
          <button
            key={p.value}
            type="button"
            className={`cf-swatch${normalizeHex(value) === p.value ? ' selected' : ''}`}
            style={{ background: p.value }}
            aria-label={p.label}
            title={p.label}
            disabled={disabled}
            onClick={() => onChange(p.value)}
          />
        ))}
      </div>

      <div className="cf-preview">
        <div className="cf-preview-half">
          <span className="cf-preview-label">Light</span>
          <div className="portal-shell">{preview}</div>
        </div>
        <div className="cf-preview-half">
          <span className="cf-preview-label">Dark</span>
          <div className="portal-shell" data-theme="dark">{preview}</div>
        </div>
      </div>
    </div>
  );
}
