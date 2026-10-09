/**
 * Developer › Database › Cleanup — remove data that can never be used again
 * (expired sign-in records) or is older than the admin chooses (finished
 * work, deleted files), plus a report-only duplicate finder.
 *
 * One card per group (Sign-in leftovers / Old history / Deleted files).
 * Each card owns its own state: an "Older than" age (History and Deleted
 * only), a toggle per category, a Preview, and a Delete selected that stays
 * disabled until a preview of the CURRENT age found something selected.
 * Changing the age drops the card's counts — they described a different
 * cutoff. The API (routes/cleanup.py, devtools/cleanup.py) owns every rule
 * about what is safe to delete; the labels below are only the pre-preview
 * catalog, and the preview's own descriptions replace the short ones here
 * once they arrive.
 *
 * A run that fails part-way returns 500 `cleanup_failed` with the counts of
 * what was already deleted — those are shown like a normal result, plus the
 * message, and the counts are refreshed either way.
 */

import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { useAuth } from '../../auth/AuthContext';
import {
  ApiError,
  getCleanupDuplicates,
  getCleanupPreview,
  runCleanup,
  type CleanupCategoryResult,
  type CleanupDuplicatesOut,
  type CleanupGroupPreview,
} from '../../lib/api';
import '../../styles/profile.css'; /* .btn-solid, .record-link */
import '../../styles/initiatives.css'; /* .init-panel, .mini-btn */
import '../../styles/settings.css'; /* .set-row, .switch */
import '../../styles/system.css'; /* .sysconf-card */
import { Switch } from '../Switch';

const DEFAULT_AGE = 90;
const MIN_AGE = 1;
const MAX_AGE = 3650;
const AGE_ERROR = `Enter a whole number of days from ${MIN_AGE} to ${MAX_AGE}.`;

interface GroupSpec {
  key: string;
  label: string;
  description: string;
  needsAge: boolean;
  categories: { key: string; label: string; description: string }[];
}

const GROUPS: GroupSpec[] = [
  {
    key: 'signin', label: 'Sign-in leftovers', needsAge: false,
    description: 'Sign-in records that have expired or been used up and can never be used again.',
    categories: [
      { key: 'sessions', label: 'Expired sessions',
        description: 'Portal and kiosk sessions past their expiry.' },
      { key: 'reset_links', label: 'Used or expired password-reset links',
        description: 'Password-reset links that were already used or have expired.' },
      { key: 'trusted_browsers', label: 'Expired or revoked trusted browsers',
        description: 'Remembered browsers whose trust has expired or was revoked.' },
    ],
  },
  {
    key: 'history', label: 'Old history', needsAge: true,
    description: 'Finished work and old records past the age you choose.',
    categories: [
      { key: 'mail', label: 'Sent, failed and skipped mail',
        description: 'Outgoing email that is done. Queued and sending mail stays.' },
      { key: 'notifications', label: 'Read or hidden notifications',
        description: 'Inbox items someone already read or hid.' },
      { key: 'imports', label: 'Finished import jobs',
        description: 'Completed, failed and canceled imports, with their uploaded file.' },
      { key: 'reports', label: 'Report runs',
        description: 'Finished report runs and their generated file.' },
      { key: 'label_runs', label: 'Label generation runs',
        description: 'Finished label generation runs. The labels they made stay.' },
      { key: 'spec_lookups', label: 'Finished spec lookups',
        description: 'Finished spec lookup jobs. Their suggestions stay.' },
      { key: 'rule_logs', label: 'Status rule run logs',
        description: 'The log of each time a status rule ran.' },
    ],
  },
  {
    key: 'deleted', label: 'Deleted files', needsAge: true,
    description: 'Files, notes and fonts that were deleted and are past the age you choose, '
      + 'along with their stored copies.',
    categories: [
      { key: 'attachments', label: 'Deleted files',
        description: 'Files and photos deleted from a record, with the stored copy.' },
      { key: 'notes', label: 'Deleted notes',
        description: 'Notes that were deleted from a record.' },
      { key: 'label_fonts', label: 'Deleted label fonts',
        description: 'Label fonts removed from the font library, with the stored font file.' },
    ],
  },
];

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** "1,204 rows · 38 files" — the files part only when there are files. */
function countText(rows: number, files: number): string {
  return files > 0
    ? `${plural(rows, 'row')} · ${plural(files, 'file')}`
    : plural(rows, 'row');
}

/** Whole days 1–3650, or null when the field isn't one. */
function parseAge(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= MIN_AGE && n <= MAX_AGE ? n : null;
}

function resultText(r: CleanupCategoryResult): string {
  const parts = [`${plural(r.rows_deleted, 'row')} deleted`];
  if (r.files_deleted > 0) parts.push(`${plural(r.files_deleted, 'file')} deleted`);
  if (r.files_kept > 0) parts.push(`${plural(r.files_kept, 'file')} kept (still in use)`);
  if (r.files_failed > 0) parts.push(`${plural(r.files_failed, 'file')} could not be deleted`);
  return parts.join(' · ');
}

function previewErrorText(err: unknown): string {
  if (err instanceof ApiError && err.code === 'invalid_age') return AGE_ERROR;
  return 'Could not load the preview — try again.';
}

interface FailedRunDetail { message?: string; categories?: CleanupCategoryResult[] }

function GroupCard({ spec, canChange }: { spec: GroupSpec; canChange: boolean }) {
  const [ageText, setAgeText] = useState(String(DEFAULT_AGE));
  const [enabled, setEnabled] = useState<Record<string, boolean>>(
    () => Object.fromEntries(spec.categories.map((c) => [c.key, true])));
  const [preview, setPreview] = useState<CleanupGroupPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [results, setResults] = useState<CleanupCategoryResult[] | null>(null);
  // bumped whenever the cutoff changes so a slow preview of the OLD age can't land
  const generation = useRef(0);

  const age = spec.needsAge ? parseAge(ageText) : DEFAULT_AGE;
  const ageInvalid = spec.needsAge && age === null;
  const busy = previewing || running;

  const loadPreview = async () => {
    if (age === null) return;
    const mine = generation.current;
    setPreviewing(true);
    try {
      const out = await getCleanupPreview(age);
      if (mine === generation.current) {
        setPreview(out.groups.find((g) => g.key === spec.key) ?? null);
      }
    } catch (err) {
      if (mine === generation.current) setError(previewErrorText(err));
    } finally {
      setPreviewing(false);
    }
  };

  const onAge = (text: string) => {
    generation.current += 1;
    setAgeText(text);
    setPreview(null);
    setError('');
  };

  const onPreview = () => {
    setError('');
    setResults(null);
    void loadPreview();
  };

  const counts = new Map((preview?.categories ?? []).map((c) => [c.key, c]));
  const selected = spec.categories.filter((c) => enabled[c.key]);
  const selRows = selected.reduce((n, c) => n + (counts.get(c.key)?.rows ?? 0), 0);
  const selFiles = selected.reduce((n, c) => n + (counts.get(c.key)?.files ?? 0), 0);
  const canDelete = canChange && !ageInvalid && preview !== null && !busy
    && selRows + selFiles > 0;

  const onDelete = async () => {
    if (age === null) return;
    const what = countText(selRows, selFiles);
    const cutoff = spec.needsAge ? ` older than ${plural(age, 'day')}` : '';
    if (!confirm(`Delete ${what}${cutoff} from "${spec.label}"? This cannot be undone.`)) return;
    setRunning(true);
    setError('');
    setResults(null);
    try {
      const out = await runCleanup({
        group: spec.key,
        categories: selected.map((c) => c.key),
        ...(spec.needsAge ? { older_than_days: age } : {}),
      });
      setResults(out.categories);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'cleanup_failed') {
        const detail = (err.detail ?? {}) as FailedRunDetail;
        setError(detail.message
          ? `The cleanup stopped part-way: ${detail.message}`
          : 'The cleanup stopped part-way.');
        setResults(detail.categories ?? []);
      } else if (err instanceof ApiError && err.code === 'invalid_age') {
        setError(AGE_ERROR);
      } else if (err instanceof ApiError && err.code === 'unknown_category') {
        setError('The server does not recognize one of these categories — reload the page.');
      } else {
        setError('The cleanup failed — try again.');
      }
    } finally {
      setRunning(false);
    }
    await loadPreview();
  };

  return (
    <section className="init-panel sysconf-card" aria-label={spec.label}
             style={{ marginBottom: 20 }}>
      <div className="sysconf-card-head">
        <div className="eyebrow-sm">{spec.label}</div>
        <p className="sysconf-card-desc">{preview?.description ?? spec.description}</p>
      </div>

      {spec.needsAge && (
        <div className="sysconf-row">
          <div className="sysconf-field">
            <label className="sysconf-label" htmlFor={`cleanup-age-${spec.key}`}>
              Older than (days)
            </label>
            <input
              id={`cleanup-age-${spec.key}`}
              type="number"
              min={MIN_AGE}
              max={MAX_AGE}
              value={ageText}
              disabled={busy}
              onChange={(e) => onAge(e.target.value)}
            />
            {ageInvalid && <p className="pf-error">{AGE_ERROR}</p>}
          </div>
        </div>
      )}

      <div className="cleanup-rows">
        {spec.categories.map((c) => {
          const found = counts.get(c.key);
          return (
            <div key={c.key} className="set-row">
              <div className="set-label">
                <b>{c.label}</b>
                <span>{found?.description ?? c.description}</span>
              </div>
              <span className="set-num-inline">
                <span>{found ? countText(found.rows, found.files) : '—'}</span>
                <Switch
                  label={c.label}
                  checked={enabled[c.key]}
                  disabled={busy}
                  onChange={(v) => setEnabled((prev) => ({ ...prev, [c.key]: v }))}
                />
              </span>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button type="button" className="mini-btn" disabled={busy || ageInvalid}
                onClick={onPreview}>
          {previewing ? 'Previewing…' : 'Preview'}
        </button>
        {canChange && (
          <button type="button" className="btn-solid btn-danger" disabled={!canDelete}
                  onClick={() => void onDelete()}>
            {running ? 'Deleting…' : 'Delete selected'}
          </button>
        )}
      </div>

      {error && <p className="pf-error">{error}</p>}

      {results && results.length > 0 && (
        <div>
          {results.map((r) => (
            <p key={r.key} className="set-ok">
              {spec.categories.find((c) => c.key === r.key)?.label ?? r.key}: {resultText(r)}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

const ASSET_COLS = 'minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 0.8fr)';
const PERSON_COLS = 'minmax(0, 1.4fr) minmax(0, 1.4fr) minmax(0, 1fr)';

/** The record's name as a link when the API gave one, plain text otherwise. */
function RecordName({ text, href }: { text: string; href: string | null }) {
  return (
    <span className="cell-top cell-line" title={text}>
      {href ? <Link className="record-link" to={href}>{text}</Link> : text}
    </span>
  );
}

function DuplicateFinder() {
  const [found, setFound] = useState<CleanupDuplicatesOut | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const find = async () => {
    setLoading(true);
    setError('');
    try {
      setFound(await getCleanupDuplicates());
    } catch {
      setError('Could not look for duplicates — try again.');
    } finally {
      setLoading(false);
    }
  };

  const none = found !== null && found.assets.length === 0 && found.people.length === 0;

  return (
    <section className="init-panel sysconf-card" aria-label="Duplicate finder"
             style={{ marginBottom: 20 }}>
      <div className="sysconf-card-head">
        <div className="eyebrow-sm">Duplicate finder</div>
        <p className="sysconf-card-desc">
          Report only — nothing is changed. Lists assets that share a serial number and
          people who share a name, so they can be fixed by hand.
        </p>
      </div>

      <div>
        <button type="button" className="mini-btn" disabled={loading} onClick={() => void find()}>
          {loading ? 'Looking…' : 'Find duplicates'}
        </button>
      </div>

      {error && <p className="pf-error">{error}</p>}
      {none && <p className="page-hint" style={{ margin: 0 }}>No duplicates found.</p>}

      {found && found.assets.length > 0 && (
        <div>
          <div className="eyebrow-sm">Assets sharing a serial number</div>
          {found.assets.map((g) => (
            <div key={g.serial} className="mini-list" style={{ marginTop: 10 }}>
              <div className="mini-list-head" style={{ gridTemplateColumns: '1fr' }}>
                <span>{g.serial} · {plural(g.items.length, 'asset')}</span>
              </div>
              {g.items.map((a) => (
                <div key={a.id} className="mini-row" style={{ gridTemplateColumns: ASSET_COLS }}>
                  <div className="cell">
                    <RecordName text={a.name ?? 'Unnamed asset'} href={a.href} />
                  </div>
                  <div className="cell">
                    <span className="mono cell-line" title={a.serial_number ?? ''}>
                      {a.serial_number ?? '—'}
                    </span>
                  </div>
                  <div className="cell">
                    <span className="cell-sub cell-line" title={a.site_name ?? ''}>
                      {a.site_name ?? 'No site'}
                    </span>
                  </div>
                  <div className="cell"><span className="chip tag">{a.status_label}</span></div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {found && found.people.length > 0 && (
        <div>
          <div className="eyebrow-sm">People sharing a name</div>
          {found.people.map((g) => (
            <div key={g.name} className="mini-list" style={{ marginTop: 10 }}>
              <div className="mini-list-head" style={{ gridTemplateColumns: '1fr' }}>
                <span>{g.name} · {plural(g.items.length, 'person', 'people')}</span>
              </div>
              {g.items.map((p) => (
                <div key={p.id} className="mini-row" style={{ gridTemplateColumns: PERSON_COLS }}>
                  <div className="cell">
                    <RecordName text={p.display_name} href={p.href} />
                  </div>
                  <div className="cell">
                    <span className="mono cell-line" title={p.email ?? ''}>{p.email ?? '—'}</span>
                  </div>
                  <div className="cell">
                    {p.has_login && <span className="chip tag">Has login</span>}
                    {p.is_worker && <span className="chip tag">Worker</span>}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default function CleanupTab({ onShowBackups }: { onShowBackups: () => void }) {
  const { can } = useAuth();
  const canChange = can('devtools', 'change');

  return (
    <>
      <p className="page-hint" style={{ marginBottom: 16 }}>
        Remove data that can never be used again or is older than you choose. Take a backup
        first — deletes can&apos;t be undone.{' '}
        <button type="button" className="mini-btn" onClick={onShowBackups}>Go to Backups</button>
      </p>

      {GROUPS.map((g) => <GroupCard key={g.key} spec={g} canChange={canChange} />)}

      <DuplicateFinder />
    </>
  );
}
