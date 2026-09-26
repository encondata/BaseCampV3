/** /libraries/new — create a library (a space in the code; people with
 *  wiki:add). A modal in the
 *  portal's header pattern over the wiki: name, key (filled from the name
 *  until edited by hand), description, icon, color and who can read it. */
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { ApiError } from '@portal/lib/api';
import { PRESET_COLORS } from '@portal/lib/variables';

import { SpaceBadge } from '../components/NodeIcon';
import { libraryPath } from '../lib/paths';
import type { SpaceCreateIn } from '../lib/types';
import { useWikiMe } from '../lib/useWikiMe';
import { createSpace, errorMessage } from '../lib/wikiApi';

export const KEY_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

/** "Field Ops & Café" → "field-ops-cafe" (at most 40 characters). */
export function slugify(name: string): string {
  return name
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

type Access = SpaceCreateIn['default_access'];
const ACCESS: { value: Access; label: string; hint: string }[] = [
  { value: 'internal', label: 'All internal staff', hint: 'Everyone on the internal team can read it.' },
  { value: 'everyone', label: 'Everyone who can sign in', hint: 'Clients and partners with wiki access can read it too.' },
  { value: 'private', label: 'Only people I add', hint: 'Only you, until you add people in the library\'s permissions.' },
];

const DEFAULT_COLOR = PRESET_COLORS.find((c) => c.label === 'Blue')?.value ?? PRESET_COLORS[0].value;

function createError(err: unknown): string {
  if (err instanceof ApiError && err.code === 'key_taken') return 'That key is already in use. Pick another.';
  return errorMessage(err, 'Couldn\'t create the library. Try again.');
}

export default function NewSpace() {
  const me = useWikiMe();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('');
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [access, setAccess] = useState<Access>('internal');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const close = () => { if (!busy) navigate('/'); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busy) navigate('/');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, navigate]);

  if (!me) return null;   // still loading
  if (!me.can_create_spaces) {
    return (
      <div className="portal-page wiki-page">
        <div className="eyebrow">Wiki</div>
        <h1 className="page-title">New library</h1>
        <p className="page-hint">You can't create libraries. Ask a wiki administrator for access.</p>
      </div>
    );
  }

  const trimmedName = name.trim();
  const keyValid = KEY_RE.test(key);
  const nameTooLong = trimmedName.length > 200;
  const canSubmit = !!trimmedName && !nameTooLong && keyValid && !busy;

  const onName = (value: string) => {
    setName(value);
    if (!keyEdited) setKey(slugify(value));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    try {
      const space = await createSpace({
        name: trimmedName,
        key,
        description: description.trim() || null,
        icon: icon.trim() || null,
        color,
        default_access: access,
      });
      navigate(libraryPath(space.key));
    } catch (err) {
      setError(createError(err));
      setBusy(false);
    }
  };

  const accessHint = ACCESS.find((a) => a.value === access)?.hint;

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal-card reports-modal-card rgm-card wiki-new-space-card" role="dialog"
           aria-modal="true" aria-labelledby="wiki-new-space-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Wiki</div>
            <h3 id="wiki-new-space-title">New library</h3>
            <p className="page-hint">A home for a team or topic, with its own pages, folders and permissions.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={close} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form onSubmit={(e) => void submit(e)}>
          <div className="modal-body wiki-new-space-body">
            <div>
              <div className="modal-section">Details</div>
              <div className="pf-form">
                <div className="full">
                  <label htmlFor="ns-name">Name</label>
                  <input id="ns-name" value={name} autoFocus disabled={busy} placeholder="Field Operations"
                         onChange={(e) => onName(e.target.value)} />
                  {nameTooLong && <p className="pf-error">Names can be up to 200 characters.</p>}
                </div>
                <div>
                  <label htmlFor="ns-key">Key</label>
                  <input id="ns-key" value={key} disabled={busy} placeholder="field-ops" spellCheck={false}
                         aria-invalid={!!key && !keyValid}
                         onChange={(e) => { setKeyEdited(true); setKey(e.target.value); }} />
                  {key && !keyValid ? (
                    <p className="pf-error wiki-field-note">
                      2–40 lowercase letters, digits or dashes, starting with a letter or digit.
                    </p>
                  ) : (
                    <p className="wiki-field-note">Used in links: {libraryPath(key || 'key')}</p>
                  )}
                </div>
                <div>
                  <label htmlFor="ns-icon">Icon</label>
                  <input id="ns-icon" value={icon} disabled={busy} placeholder="📘" maxLength={8}
                         onChange={(e) => setIcon(e.target.value)} />
                  <p className="wiki-field-note">An emoji, or leave it blank for a book in the library’s color.</p>
                </div>
                <div className="full">
                  <label htmlFor="ns-desc">Description</label>
                  <input id="ns-desc" value={description} disabled={busy} placeholder="What lives here"
                         onChange={(e) => setDescription(e.target.value)} />
                </div>
              </div>

              <div className="modal-section">Color</div>
              <div className="cf-swatches wiki-swatches">
                {PRESET_COLORS.map((p) => (
                  <button key={p.value} type="button" aria-label={p.label} title={p.label}
                          aria-pressed={color === p.value} disabled={busy}
                          className={`cf-swatch${color === p.value ? ' selected' : ''}`}
                          style={{ background: p.value }} onClick={() => setColor(p.value)} />
                ))}
              </div>

              <div className="modal-section">Who can read it</div>
              <div className="segmented" role="group" aria-label="Who can read it">
                {ACCESS.map((a) => (
                  <button key={a.value} type="button" className={access === a.value ? 'on' : ''}
                          aria-pressed={access === a.value} disabled={busy}
                          onClick={() => setAccess(a.value)}>
                    {a.label}
                  </button>
                ))}
              </div>
              <p className="wiki-field-note">{accessHint} You can change this later.</p>
            </div>

            <div className="wiki-new-space-preview" aria-hidden="true">
              <div className="modal-section">Preview</div>
              <div className="wiki-space-card wiki-space-card-static">
                <SpaceBadge space={{ icon: icon.trim() || null, name: trimmedName || 'N', color }} size="lg" />
                <span className="wiki-space-card-text">
                  <b>{trimmedName || 'New library'}</b>
                  <span>{description.trim() || 'What lives here'}</span>
                </span>
              </div>
            </div>

            {error && <p className="pf-error wiki-new-space-error">{error}</p>}
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={!canSubmit}>
              {busy ? 'Creating…' : 'Create library'}
            </button>
            <button className="mini-btn" type="button" onClick={close} disabled={busy}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
