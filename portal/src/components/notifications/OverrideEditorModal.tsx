/**
 * OverrideEditorModal — per-member override editor opened from
 * MembersPanel's row Edit action. Every setting is an explicit
 * inherit-vs-custom choice (a "Group default (…)" / "Custom" — or, for
 * quiet hours, "…" / "None" / "Custom" — <select>, per house convention
 * for small fixed enums) so inheritance stays legible rather than an
 * implicit "blank means inherit". Diffs each field's mode+value against
 * the member's loaded overrides so the PATCH carries only what changed,
 * with an explicit `null` for anything reset back to inherit (Task 2's
 * PATCH distinguishes an absent field from one explicitly set to null).
 */

import { useState, type FormEvent } from 'react';

import {
  ApiError, updateNotificationMember,
  type NotificationGroupDetail, type NotificationMember, type NotificationMemberOverrides,
} from '../../lib/api';
import {
  CHANNELS, CHANNEL_LABELS, DAYS, canForChannel, formatDays, formatQuietHours,
  type Channel, type Day,
} from '../../lib/notifications';
import { avatarGradient, initials } from '../../lib/format';

type Mode = 'default' | 'custom';
type QuietMode = 'default' | 'none' | 'custom';

const DAY_LABELS: Record<Day, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
};

const DND_LABELS: Record<string, string> = {
  defer: 'Defer until window opens',
  skip: 'Skip entirely',
};

/** The 8 common IANA zones offered here — same curated list as
 *  EditSettingsModal's group-level timezone picker. */
const TIMEZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix',
  'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'UTC',
];

const ERRORS: Record<string, string> = {
  channel_unavailable: "That channel isn't available for this person.",
  invalid_quiet_hours: "Quiet hours need both a start and an end (and they can't be equal).",
  invalid_timezone: 'That timezone is not recognized.',
  invalid_days: 'Pick at least one active day.',
};

const msgFor = (err: unknown): string =>
  err instanceof ApiError
    ? (ERRORS[err.code] ?? `Request failed (${err.code}).`)
    : 'Network error — nothing was saved.';

/** True when `a` and `b` contain the same members, order-independent. */
function sameArr(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((x) => setB.has(x));
}

/** Local copy of pages/Settings.tsx's aligned labeled switch — a bare
 *  <input type="checkbox"> would violate the "never a raw floating
 *  checkbox" form rule, so every boolean here is one of these. */
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

export default function OverrideEditorModal({ group, member, onClose, onSaved }: {
  group: NotificationGroupDetail;
  member: NotificationMember;
  onClose: () => void;
  onSaved: () => void;
}) {
  const ov = member.overrides;

  const [channelsMode, setChannelsMode] = useState<Mode>(ov.channels === null ? 'default' : 'custom');
  const [channelsCustom, setChannelsCustom] = useState<Set<Channel>>(
    () => new Set((ov.channels ?? []) as Channel[]));

  const [quietMode, setQuietMode] = useState<QuietMode>(
    ov.quiet_mode === null ? 'default' : (ov.quiet_mode as QuietMode));
  const [quietStart, setQuietStart] = useState(ov.quiet_start ? ov.quiet_start.slice(0, 5) : '');
  const [quietEnd, setQuietEnd] = useState(ov.quiet_end ? ov.quiet_end.slice(0, 5) : '');

  const [timezoneMode, setTimezoneMode] = useState<Mode>(ov.timezone === null ? 'default' : 'custom');
  const [timezoneCustom, setTimezoneCustom] = useState(ov.timezone ?? group.timezone);

  const [daysMode, setDaysMode] = useState<Mode>(ov.active_days === null ? 'default' : 'custom');
  const [daysCustom, setDaysCustom] = useState<Set<Day>>(
    () => new Set((ov.active_days ?? []) as Day[]));

  const [dndMode, setDndMode] = useState<Mode>(ov.dnd_behavior === null ? 'default' : 'custom');
  const [dndCustom, setDndCustom] = useState(ov.dnd_behavior ?? group.dnd_behavior);

  const [urgentMode, setUrgentMode] = useState<Mode>(ov.urgent_bypass === null ? 'default' : 'custom');
  const [urgentCustom, setUrgentCustom] = useState(ov.urgent_bypass ?? group.urgent_bypass);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const reachableChannels = CHANNELS.filter((c) => canForChannel(member, c));

  const toggleChannel = (c: Channel, on: boolean) => setChannelsCustom((prev) => {
    const next = new Set(prev);
    if (on) next.add(c); else next.delete(c);
    return next;
  });

  const toggleDay = (d: Day) => setDaysCustom((prev) => {
    const next = new Set(prev);
    if (next.has(d)) next.delete(d); else next.add(d);
    return next;
  });

  const groupChannelsLabel = group.channels.length
    ? group.channels.map((c) => CHANNEL_LABELS[c as Channel] ?? c).join(', ')
    : 'None';
  const groupQuietLabel = formatQuietHours(group.quiet_start, group.quiet_end, group.timezone);
  const groupDaysLabel = formatDays(group.active_days);
  const groupDndLabel = DND_LABELS[group.dnd_behavior] ?? group.dnd_behavior;
  const groupUrgentLabel = group.urgent_bypass ? 'Ignores quiet hours' : 'Respects quiet hours';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (daysMode === 'custom' && daysCustom.size === 0) {
      setError(ERRORS.invalid_days);
      return;
    }
    if (quietMode === 'custom' && (!quietStart || !quietEnd || quietStart === quietEnd)) {
      setError(ERRORS.invalid_quiet_hours);
      return;
    }

    const patch: Partial<NotificationMemberOverrides> = {};

    const nextChannelsArr = CHANNELS.filter((c) => channelsCustom.has(c));
    const origChannelsMode: Mode = ov.channels === null ? 'default' : 'custom';
    if (channelsMode !== origChannelsMode
        || (channelsMode === 'custom' && !sameArr(nextChannelsArr, ov.channels ?? []))) {
      patch.channels = channelsMode === 'default' ? null : nextChannelsArr;
    }

    const nextQuietMode = quietMode === 'default' ? null : quietMode;
    const nextQuietStart = quietMode === 'custom' ? `${quietStart}:00` : null;
    const nextQuietEnd = quietMode === 'custom' ? `${quietEnd}:00` : null;
    if (nextQuietMode !== ov.quiet_mode
        || nextQuietStart !== ov.quiet_start
        || nextQuietEnd !== ov.quiet_end) {
      patch.quiet_mode = nextQuietMode;
      patch.quiet_start = nextQuietStart;
      patch.quiet_end = nextQuietEnd;
    }

    const nextTz = timezoneMode === 'default' ? null : timezoneCustom;
    if (nextTz !== ov.timezone) patch.timezone = nextTz;

    const nextDaysArr = DAYS.filter((d) => daysCustom.has(d));
    const daysChanged = daysMode === 'default'
      ? ov.active_days !== null
      : (ov.active_days === null || !sameArr(nextDaysArr, ov.active_days));
    if (daysChanged) patch.active_days = daysMode === 'default' ? null : nextDaysArr;

    const nextDnd = dndMode === 'default' ? null : dndCustom;
    if (nextDnd !== ov.dnd_behavior) patch.dnd_behavior = nextDnd;

    const nextUrgent = urgentMode === 'default' ? null : urgentCustom;
    if (nextUrgent !== ov.urgent_bypass) patch.urgent_bypass = nextUrgent;

    setSaving(true);
    try {
      await updateNotificationMember(group.id, member.person_id, patch);
      onSaved();
    } catch (err) {
      setError(msgFor(err));
    } finally {
      setSaving(false);
    }
  };

  const dismiss = () => { if (!saving) onClose(); };

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget) dismiss();
    }}>
      <div className="modal-card">
        <div className="modal-head">
          <div className="ov-head">
            <span className="av-sm"
                  style={{ background: member.avatar_url ? 'var(--surface-2)' : avatarGradient(member.display_name) }}>
              {member.avatar_url ? <img src={member.avatar_url} alt="" /> : initials(member.display_name)}
            </span>
            <h3>Overrides — {member.display_name}</h3>
          </div>
          <button className="modal-close" aria-label="Close" onClick={dismiss}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form onSubmit={submit}>
          <div className="modal-body">
            <div className="modal-section">Channels</div>
            <div className="pf-form">
              <div className="full">
                <label htmlFor="ov-channels-mode">Channels</label>
                <select id="ov-channels-mode" value={channelsMode} disabled={saving}
                        onChange={(e) => setChannelsMode(e.target.value as Mode)}>
                  <option value="default">{`Group default (${groupChannelsLabel})`}</option>
                  <option value="custom">Custom</option>
                </select>
              </div>
              {channelsMode === 'custom' && (
                <>
                  {reachableChannels.map((c) => (
                    <div className="full ngd-switch-row" key={c}>
                      <span>{CHANNEL_LABELS[c]}</span>
                      <Switch checked={channelsCustom.has(c)} label={CHANNEL_LABELS[c]} disabled={saving}
                              onChange={(v) => toggleChannel(c, v)} />
                    </div>
                  ))}
                  {channelsCustom.size === 0 && (
                    <p className="full set-note" style={{ padding: '4px 0 0' }}>
                      This member will receive nothing from this group.
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="modal-section">Quiet hours</div>
            <div className="pf-form">
              <div className="full">
                <label htmlFor="ov-quiet-mode">Quiet hours</label>
                <select id="ov-quiet-mode" value={quietMode} disabled={saving}
                        onChange={(e) => setQuietMode(e.target.value as QuietMode)}>
                  <option value="default">{`Group default (${groupQuietLabel})`}</option>
                  <option value="none">None</option>
                  <option value="custom">Custom</option>
                </select>
              </div>
              {quietMode === 'custom' && (
                <>
                  <div>
                    <label htmlFor="ov-quiet-start">Start</label>
                    <input id="ov-quiet-start" type="time" value={quietStart} disabled={saving}
                           onChange={(e) => setQuietStart(e.target.value)} />
                  </div>
                  <div>
                    <label htmlFor="ov-quiet-end">End</label>
                    <input id="ov-quiet-end" type="time" value={quietEnd} disabled={saving}
                           onChange={(e) => setQuietEnd(e.target.value)} />
                  </div>
                </>
              )}
            </div>

            <div className="modal-section">Timezone</div>
            <div className="pf-form">
              <div className="full">
                <label htmlFor="ov-tz-mode">Timezone</label>
                <select id="ov-tz-mode" value={timezoneMode} disabled={saving}
                        onChange={(e) => setTimezoneMode(e.target.value as Mode)}>
                  <option value="default">{`Group default (${group.timezone})`}</option>
                  <option value="custom">Custom</option>
                </select>
              </div>
              {timezoneMode === 'custom' && (
                <div className="full">
                  <label htmlFor="ov-tz-custom">Custom timezone</label>
                  <select id="ov-tz-custom" value={timezoneCustom} disabled={saving}
                          onChange={(e) => setTimezoneCustom(e.target.value)}>
                    {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                  </select>
                </div>
              )}
            </div>

            <div className="modal-section">Active days</div>
            <div className="pf-form">
              <div className="full">
                <label htmlFor="ov-days-mode">Active days</label>
                <select id="ov-days-mode" value={daysMode} disabled={saving}
                        onChange={(e) => setDaysMode(e.target.value as Mode)}>
                  <option value="default">{`Group default (${groupDaysLabel})`}</option>
                  <option value="custom">Custom</option>
                </select>
              </div>
            </div>
            {daysMode === 'custom' && (
              <div className="day-pills">
                {DAYS.map((d) => (
                  <button type="button" key={d} disabled={saving}
                          className={`mini-btn${daysCustom.has(d) ? ' active' : ''}`}
                          onClick={() => toggleDay(d)}>
                    {DAY_LABELS[d]}
                  </button>
                ))}
              </div>
            )}

            <div className="modal-section">Behavior</div>
            <div className="pf-form">
              <div className="full">
                <label htmlFor="ov-dnd-mode">When blocked</label>
                <select id="ov-dnd-mode" value={dndMode} disabled={saving}
                        onChange={(e) => setDndMode(e.target.value as Mode)}>
                  <option value="default">{`Group default (${groupDndLabel})`}</option>
                  <option value="custom">Custom</option>
                </select>
              </div>
              {dndMode === 'custom' && (
                <div className="full">
                  <label htmlFor="ov-dnd-custom">Custom behavior</label>
                  <select id="ov-dnd-custom" value={dndCustom} disabled={saving}
                          onChange={(e) => setDndCustom(e.target.value)}>
                    <option value="defer">Defer until window opens</option>
                    <option value="skip">Skip entirely</option>
                  </select>
                </div>
              )}
              <div className="full">
                <label htmlFor="ov-urgent-mode">Urgent bypass</label>
                <select id="ov-urgent-mode" value={urgentMode} disabled={saving}
                        onChange={(e) => setUrgentMode(e.target.value as Mode)}>
                  <option value="default">{`Group default (${groupUrgentLabel})`}</option>
                  <option value="custom">Custom</option>
                </select>
              </div>
              {urgentMode === 'custom' && (
                <div className="full ngd-switch-row">
                  <span>Urgent bypass</span>
                  <Switch checked={urgentCustom} label="Urgent bypass" disabled={saving}
                          onChange={setUrgentCustom} />
                </div>
              )}
            </div>

            {error && <span className="pf-error">{error}</span>}
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button className="mini-btn" type="button" onClick={dismiss} disabled={saving}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
