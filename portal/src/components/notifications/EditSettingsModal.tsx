/**
 * EditSettingsModal — the delivery-defaults editor (channels, quiet
 * hours, timezone, active days, when-blocked, urgent bypass) for a
 * notification group, invoked from the Delivery defaults panel's
 * "Edit settings" button. 2-col label-above-control .pf-form grid
 * throughout; every boolean is an aligned labeled switch row
 * (.ngd-switch-row), never a bare checkbox. Diffs every field against
 * the loaded group so the PATCH body carries only what actually changed.
 */

import { useState, type FormEvent } from 'react';

import {
  ApiError, updateNotificationGroup,
  type NotificationGroupDetail, type NotificationGroupPatchIn,
} from '../../lib/api';
import { CHANNEL_LABELS, CHANNELS, DAYS, type Channel, type Day } from '../../lib/notifications';

const DAY_LABELS: Record<Day, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
};

/** The 8 common IANA zones the settings modal offers — deliberately a
 *  short curated list rather than the full tz database. */
const TIMEZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix',
  'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'UTC',
];

const ERRORS: Record<string, string> = {
  invalid_quiet_hours: "Quiet hours need both a start and an end (and they can't be equal).",
  invalid_timezone: 'That timezone is not recognized.',
  invalid_days: 'Pick at least one active day.',
};

const msgFor = (err: unknown): string =>
  err instanceof ApiError
    ? (ERRORS[err.code] ?? `Request failed (${err.code}).`)
    : 'Network error — nothing was saved.';

/** True when `a` and `b` contain the same members, order-independent. */
function sameMembers(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((x) => setB.has(x));
}

/** Reused from pages/Settings.tsx (33-62) — the app's aligned labeled
 *  switch: a bare <input type="checkbox"> would violate the "never a raw
 *  floating checkbox" form rule, so every boolean in this modal is one of
 *  these, paired with a sibling label in a flex row. `label` sets the
 *  input's accessible name since the switch itself carries no visible text. */
function Switch({ checked, onChange, disabled = false, label }: {
  checked: boolean;
  onChange?: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} disabled={disabled} aria-label={label}
             onChange={(e) => onChange?.(e.target.checked)} />
      <span className="track" />
    </label>
  );
}

export default function EditSettingsModal({ group, onClose, onSaved }: {
  group: NotificationGroupDetail;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [channels, setChannels] = useState<Set<Channel>>(
    () => new Set(group.channels as Channel[]));
  const [quietMode, setQuietMode] = useState<'off' | 'custom'>(
    group.quiet_start !== null ? 'custom' : 'off');
  const [quietStart, setQuietStart] = useState(
    group.quiet_start ? group.quiet_start.slice(0, 5) : '');
  const [quietEnd, setQuietEnd] = useState(
    group.quiet_end ? group.quiet_end.slice(0, 5) : '');
  const [timezone, setTimezone] = useState(group.timezone);
  const [activeDays, setActiveDays] = useState<Set<Day>>(
    () => new Set(group.active_days as Day[]));
  const [dndBehavior, setDndBehavior] = useState(group.dnd_behavior);
  const [urgentBypass, setUrgentBypass] = useState(group.urgent_bypass);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const toggleChannel = (c: Channel, on: boolean) => setChannels((prev) => {
    const next = new Set(prev);
    if (on) next.add(c); else next.delete(c);
    return next;
  });

  const toggleDay = (d: Day) => setActiveDays((prev) => {
    const next = new Set(prev);
    if (next.has(d)) next.delete(d); else next.add(d);
    return next;
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    // Client-side guards mirroring the server's 422s (Global Constraints:
    // active_days must be non-empty; quiet_start === quiet_end is rejected).
    if (activeDays.size === 0) {
      setError(ERRORS.invalid_days);
      return;
    }
    if (quietMode === 'custom' && (!quietStart || !quietEnd || quietStart === quietEnd)) {
      setError(ERRORS.invalid_quiet_hours);
      return;
    }

    const patch: NotificationGroupPatchIn = {};

    const nextChannels = CHANNELS.filter((c) => channels.has(c));
    if (!sameMembers(nextChannels, group.channels)) patch.channels = nextChannels;

    const origMode = group.quiet_start !== null ? 'custom' : 'off';
    const nextStart = quietMode === 'custom' ? `${quietStart}:00` : null;
    const nextEnd = quietMode === 'custom' ? `${quietEnd}:00` : null;
    if (quietMode !== origMode || nextStart !== group.quiet_start || nextEnd !== group.quiet_end) {
      patch.quiet_start = nextStart;
      patch.quiet_end = nextEnd;
    }

    if (timezone !== group.timezone) patch.timezone = timezone;

    const nextDays = DAYS.filter((d) => activeDays.has(d));
    if (!sameMembers(nextDays, group.active_days)) patch.active_days = nextDays;

    if (dndBehavior !== group.dnd_behavior) patch.dnd_behavior = dndBehavior;
    if (urgentBypass !== group.urgent_bypass) patch.urgent_bypass = urgentBypass;

    setSaving(true);
    try {
      await updateNotificationGroup(group.id, patch);
      onSaved();
    } catch (err) {
      setError(msgFor(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="modal-card">
        <div className="modal-head">
          <h3>Edit settings</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form onSubmit={submit}>
          <div className="modal-body">
            <div className="ngd-section">Channels</div>
            <div className="pf-form">
              {CHANNELS.map((c) => (
                <div className="full ngd-switch-row" key={c}>
                  <span>{CHANNEL_LABELS[c]}</span>
                  <Switch checked={channels.has(c)} label={CHANNEL_LABELS[c]} disabled={saving}
                          onChange={(v) => toggleChannel(c, v)} />
                </div>
              ))}
            </div>

            <div className="ngd-section">Quiet hours</div>
            <div className="pf-form">
              <div>
                <label htmlFor="ngd-quiet-mode">Window</label>
                <select id="ngd-quiet-mode" value={quietMode} disabled={saving}
                        onChange={(e) => setQuietMode(e.target.value as 'off' | 'custom')}>
                  <option value="off">Off</option>
                  <option value="custom">Custom</option>
                </select>
              </div>
              <div>
                <label htmlFor="ngd-timezone">Timezone</label>
                <select id="ngd-timezone" value={timezone} disabled={saving}
                        onChange={(e) => setTimezone(e.target.value)}>
                  {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                </select>
              </div>
              {quietMode === 'custom' && (
                <>
                  <div>
                    <label htmlFor="ngd-quiet-start">Start</label>
                    <input id="ngd-quiet-start" type="time" value={quietStart} disabled={saving}
                           onChange={(e) => setQuietStart(e.target.value)} />
                  </div>
                  <div>
                    <label htmlFor="ngd-quiet-end">End</label>
                    <input id="ngd-quiet-end" type="time" value={quietEnd} disabled={saving}
                           onChange={(e) => setQuietEnd(e.target.value)} />
                  </div>
                </>
              )}
            </div>

            <div className="ngd-section">Active days</div>
            <div className="day-pills">
              {DAYS.map((d) => (
                <button type="button" key={d} disabled={saving}
                        className={`mini-btn${activeDays.has(d) ? ' active' : ''}`}
                        onClick={() => toggleDay(d)}>
                  {DAY_LABELS[d]}
                </button>
              ))}
            </div>

            <div className="ngd-section">Behavior</div>
            <div className="pf-form">
              <div>
                <label htmlFor="ngd-dnd">When blocked</label>
                <select id="ngd-dnd" value={dndBehavior} disabled={saving}
                        onChange={(e) => setDndBehavior(e.target.value)}>
                  <option value="defer">Defer until window opens</option>
                  <option value="skip">Skip entirely</option>
                </select>
              </div>
              <div className="full ngd-switch-row">
                <span>Urgent bypass</span>
                <Switch checked={urgentBypass} label="Urgent bypass" disabled={saving}
                        onChange={setUrgentBypass} />
              </div>
            </div>

            {error && <span className="pf-error">{error}</span>}
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button className="mini-btn" type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
