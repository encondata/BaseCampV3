/**
 * The Dock screen (/dock) — where a Dock laptop's Home tile and Kiosk Setup
 * land, and what someone on the dock watches while tuning: the pass still
 * open, filling in live with the time left before it closes; the newest
 * closed passes with their outcome, each opening its full detail; and the
 * dry-run switch and quiet gap, both saved on the laptop's edge. Always
 * dark and filling the screen like the RFID Reader dashboard, whose panels
 * it reuses; both panels show only the rows that fit. The overview
 * refreshes 1 s after the previous refresh settles (never overlapping);
 * while refreshes fail, a red line says the station can't be reached and the
 * last overview stays under it. Web mode, or a setup that isn't a Dock,
 * goes home; a new laptop browser with no setup yet shows nothing until
 * the laptop's has loaded (KioskShell looks for it), then decides.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';

import DockPassModal, { passOutcome } from '../components/DockPassModal';
import { Switch } from '../components/Switch';
import {
  getDock, saveDockSettings,
  type DockOverview, type DockPassRow, type DockSettings, type DockTag, type DockTagKind,
} from '../lib/api';
import { useKioskSetup } from '../lib/kioskSetup';
import { useLaptopSetupSettled } from '../lib/laptopSetup';
import { isLaptop } from '../lib/platform';
import { useFitRows } from '../lib/useFitRows';
import { clockText, displayEpc } from './RfidStatus';

const POLL_MS = 1000;
const GAP_MIN = 1;
const GAP_MAX = 60;

/** A tag's kind as a chip: its word and color. */
function kindChip(kind: DockTagKind): { label: string; tone: string } {
  switch (kind) {
    case 'container': return { label: 'Crate', tone: 'c-blue' };
    case 'asset': return { label: 'Asset', tone: 'c-green' };
    case 'person': return { label: 'Person', tone: 'c-slate' };
    case 'off_move': return { label: 'Off-move', tone: 'c-red' };
    default: return { label: 'Unknown', tone: 'tag' };
  }
}

/** The open pass's tags as listed: crates first (the pass's destination is
 *  never the row cut off), then everything else newest first (so a tag just
 *  read isn't either). */
function listedTags(tags: DockTag[]): DockTag[] {
  return [...tags.filter((t) => t.kind === 'container'),
    ...tags.filter((t) => t.kind !== 'container').reverse()];
}

/** A whole number of seconds in range, or null. */
function parseGap(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= GAP_MIN && n <= GAP_MAX ? n : null;
}

function countdownText(secondsLeft: number): string {
  const s = Math.ceil(secondsLeft);
  return s > 0 ? `Closes in ${s} s` : 'Closing…';
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** No crate (or several), or the portal turned the pass away. */
const standsOut = (p: DockPassRow) => p.status === 'flagged' || p.status === 'refused';

export default function DockStation() {
  const [setup] = useKioskSetup();
  const setupSettled = useLaptopSetupSettled();
  const laptop = isLaptop();
  const dock = laptop && setup?.stationType === 'dock';
  const [overview, setOverview] = useState<DockOverview | null>(null);
  const [settings, setSettings] = useState<DockSettings | null>(null);
  /** The quiet gap as typed; null shows the saved value. */
  const [gapDraft, setGapDraft] = useState<string | null>(null);
  const [gapInvalid, setGapInvalid] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  /** The last refresh failed; cleared by the next one that works. */
  const [unreachable, setUnreachable] = useState(false);
  const mounted = useRef(true);
  // Bumped when a settings save starts and again when it settles: a refresh
  // that began before either keeps its passes but not its settings, which
  // may predate the save.
  const settingsGen = useRef(0);
  const tagsBox = useRef<HTMLUListElement>(null);
  const passesBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!dock) return undefined;
    // This run's own flag, not a shared ref: a run that was cleaned up (a
    // StrictMode double mount, an unmount) never writes or schedules again.
    let live = true;
    let timer: number | undefined;
    const tick = async () => {
      const gen = settingsGen.current;
      try {
        const o = await getDock();
        if (!live) return;
        setOverview(o);
        setUnreachable(false);
        if (gen === settingsGen.current) setSettings(o.settings);
      } catch {
        // The last overview stays on screen, under a line saying it's stale.
        if (!live) return;
        setUnreachable(true);
      }
      timer = window.setTimeout(() => { void tick(); }, POLL_MS);
    };
    void tick();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [dock]);

  useFitRows(tagsBox, [overview]);
  useFitRows(passesBox, [overview]);

  const closeDetail = useCallback(() => setDetailId(null), []);

  if (laptop && setup === null && !setupSettled) return null;   // the laptop's may be on its way
  if (!dock) return <Navigate to="/" replace />;

  /** Saves one setting; true when the edge took it. */
  const save = async (next: Partial<DockSettings>): Promise<boolean> => {
    settingsGen.current += 1;
    setSaving(true);
    setSaveFailed(false);
    let ok = false;
    try {
      const saved = await saveDockSettings(next);
      if (mounted.current) setSettings(saved);
      ok = true;
    } catch {
      if (mounted.current) setSaveFailed(true);
    }
    settingsGen.current += 1;
    if (mounted.current) setSaving(false);
    return ok;
  };

  const gapChanged = settings !== null && gapDraft !== null
    && gapDraft.trim() !== String(settings.quiet_gap_s);

  const saveGap = async () => {
    if (gapDraft === null || !gapChanged || saving) return;
    const n = parseGap(gapDraft);
    if (n === null) {
      setGapInvalid(true);
      return;
    }
    if (await save({ quiet_gap_s: n }) && mounted.current) setGapDraft(null);
  };

  const open = overview?.open ?? null;
  const passes = overview?.passes ?? null;

  return (
    <div className="portal-page rfid-dash dock-dash">
      <h1 className="sr-only">Dock</h1>

      {/* Disabled until the edge's settings arrive: before that a change
          would be made against defaults. */}
      <fieldset className="dock-dash-controls" disabled={settings === null}>
        <legend className="sr-only">Dock settings</legend>
        <div className="dock-dash-control">
          <div>
            <span className="settings-row-label">Dry run</span>
            <p className="settings-row-hint">Passes are shown here and nothing is sent to the portal.</p>
          </div>
          <Switch on={settings?.dry_run ?? true} aria-label="Dry run"
                  onChange={(on) => { if (!saving) void save({ dry_run: on }); }} />
        </div>
        <div className="dock-dash-control">
          <div>
            <label htmlFor="dock-quiet-gap" className="settings-row-label">Quiet gap</label>
            <p id="dock-quiet-gap-hint"
               className={gapInvalid ? 'settings-row-hint form-error' : 'settings-row-hint'}>
              1–60 seconds
            </p>
          </div>
          <span className="alarm-seconds">
            <input
              id="dock-quiet-gap"
              type="number"
              inputMode="numeric"
              min={GAP_MIN}
              max={GAP_MAX}
              step={1}
              aria-describedby="dock-quiet-gap-hint"
              aria-invalid={gapInvalid || undefined}
              value={gapDraft ?? (settings ? String(settings.quiet_gap_s) : '')}
              onChange={(e) => { setGapDraft(e.target.value); setGapInvalid(false); }}
              onKeyDown={(e) => { if (e.key === 'Enter') void saveGap(); }}
            />
            <span className="alarm-seconds-unit">s</span>
            <button type="button" className="mini-btn" disabled={!gapChanged || saving}
                    onClick={() => void saveGap()}>
              Save
            </button>
          </span>
        </div>
        {saveFailed && <p className="form-error" role="alert">Couldn&apos;t save. Try again.</p>}
      </fieldset>

      {settings?.dry_run && (
        <p className="dock-dash-banner" role="status">Dry run · nothing is sent to the portal.</p>
      )}
      {/* The RFID dashboard's Unreachable look: red, with its dot. */}
      {unreachable && (
        <p className="rfid-dash-state is-unreachable dock-dash-unreachable" role="alert">
          <span className="rfid-dash-dot" />Can&apos;t reach the station. Retrying…
        </p>
      )}

      <div className="rfid-dash-panels dock-dash-panels">
        <section className="rfid-dash-panel" aria-labelledby="dock-open-title">
          <h2 id="dock-open-title" className="rfid-dash-panel-title">Open pass</h2>
          {overview === null && <p className="rfid-dash-empty">Checking…</p>}
          {overview !== null && open === null && (
            <p className="rfid-dash-empty">Waiting for tags…</p>
          )}
          {open && (
            <>
              <p className="dock-dash-countdown">{countdownText(open.seconds_left)}</p>
              <p className="rfid-dash-panel-sub">
                {count(open.crate_count, 'crate')} · {count(open.asset_count, 'asset')}
              </p>
              <ul className="dock-dash-tags" ref={tagsBox}>
                {listedTags(open.tags).map((t) => {
                  const chip = kindChip(t.kind);
                  return (
                    <li key={t.epc} data-fit-row className="dock-dash-tag">
                      <span className={`chip ${chip.tone}`}>{chip.label}</span>
                      <span className={t.label ? 'dock-dash-tag-label' : 'dock-dash-tag-label is-unknown'}>
                        {t.label ?? 'Unknown tag'}
                      </span>
                      <span className="dock-dash-tag-epc" title={t.epc}>{displayEpc(t.epc)}</span>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>

        <section className="rfid-dash-panel" aria-labelledby="dock-recent-title">
          <h2 id="dock-recent-title" className="rfid-dash-panel-title">Recent passes</h2>
          <p className="rfid-dash-panel-sub">Newest first.</p>
          <div className="local-table-wrap" ref={passesBox}>
            <table className="local-table dock-dash-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Crate</th>
                  <th>Assets</th>
                  <th>Outcome</th>
                  <th>Moved</th>
                  <th aria-label="Details" />
                </tr>
              </thead>
              <tbody>
                {passes === null && (
                  <tr>
                    <td colSpan={6} className="rfid-dash-empty">Checking…</td>
                  </tr>
                )}
                {passes !== null && passes.length === 0 && (
                  <tr>
                    <td colSpan={6} className="rfid-dash-empty">No passes yet.</td>
                  </tr>
                )}
                {passes?.map((p) => (
                  <tr key={p.id} data-fit-row className={standsOut(p) ? 'is-flagged' : undefined}>
                    <td className="mono">{clockText(new Date(p.opened_at))}</td>
                    <td>{p.container_name ?? '—'}</td>
                    <td className="mono">{p.asset_count}</td>
                    <td className="dock-dash-outcome">{passOutcome(p)}</td>
                    {/* Only a sent pass has moved anything. */}
                    <td className="mono">{p.status === 'packed' ? p.moved_count : '—'}</td>
                    <td className="dock-dash-action">
                      <button type="button" className="mini-btn" onClick={() => setDetailId(p.id)}>
                        Details
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {detailId !== null && <DockPassModal key={detailId} passId={detailId} onClose={closeDetail} />}
    </div>
  );
}
