/**
 * EditSettingsModal — the delivery-defaults editor (channels, categories,
 * quiet hours, timezone, active days, when-blocked, urgent bypass) for a
 * notification group, invoked from the Delivery defaults panel's "Edit
 * settings" button. House controls throughout: a Switch for each live
 * channel (Email — Text, Push and Web cannot send, so they are not offered),
 * segmented Off | Custom and Defer | Skip, ComboBox pickers for the
 * quarter-hour times and the timezone, and .ngd-switch-row labeled switches
 * for every boolean, never a bare checkbox. Diffs every field against the
 * loaded group so the PATCH body carries only what actually changed; a stored
 * channel the screen hides is never dropped — the saved list is the live
 * selections plus the hidden ones already stored.
 */

import { useId, useMemo, useState, type FormEvent } from 'react';

import {
  ApiError, updateNotificationGroup,
  type NotificationGroupDetail, type NotificationGroupPatchIn,
} from '../../lib/api';
import { NOTIFICATION_CATEGORIES, type NotificationCategory } from '../../lib/notificationKinds';
import {
  CHANNEL_LABELS, CHANNELS, DAYS, LIVE_CHANNELS, liveChannels, timezoneOptions,
  type Channel, type Day,
} from '../../lib/notifications';
import { timeOptions } from '../../lib/timeChoices';
import ComboBox from '../ComboBox';
import { Switch } from '../Switch';
import ChoiceField from './ChoiceField';
import NotificationModal from './NotificationModal';

const DAY_LABELS: Record<Day, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
};

type QuietMode = 'off' | 'custom';

const QUIET_CHOICES: { key: QuietMode; label: string }[] = [
  { key: 'off', label: 'Off' },
  { key: 'custom', label: 'Custom' },
];

const DND_CHOICES = [
  { key: 'defer', label: 'Defer until window opens' },
  { key: 'skip', label: 'Skip entirely' },
];

const ERRORS: Record<string, string> = {
  invalid_quiet_hours: "Quiet hours need both a start and an end (and they can't be equal).",
  invalid_timezone: 'That timezone is not recognized.',
  invalid_days: 'Pick at least one active day.',
  invalid_category: 'That category is not recognized.',
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

/** The API's "HH:MM:SS" as the pickers' "HH:MM"; null stays null. */
const clock = (t: string | null): string | null => (t === null ? null : t.slice(0, 5));

export default function EditSettingsModal({ group, onClose, onSaved }: {
  group: NotificationGroupDetail;
  onClose: () => void;
  onSaved: () => void;
}) {
  const formId = useId();
  // Only the live channels are switches; the rest of the stored list is kept as is on save.
  const [channels, setChannels] = useState<Set<Channel>>(
    () => new Set(liveChannels(group.channels)));
  const [categories, setCategories] = useState<Set<NotificationCategory>>(
    () => new Set(group.categories as NotificationCategory[]));
  const [quietMode, setQuietMode] = useState<QuietMode>(
    group.quiet_start !== null ? 'custom' : 'off');
  const [quietStart, setQuietStart] = useState(clock(group.quiet_start) ?? '');
  const [quietEnd, setQuietEnd] = useState(clock(group.quiet_end) ?? '');
  const [timezone, setTimezone] = useState(group.timezone);
  const [activeDays, setActiveDays] = useState<Set<Day>>(
    () => new Set(group.active_days as Day[]));
  const [dndBehavior, setDndBehavior] = useState(group.dnd_behavior);
  const [urgentBypass, setUrgentBypass] = useState(group.urgent_bypass);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const startOptions = useMemo(() => timeOptions(group.quiet_start), [group.quiet_start]);
  const endOptions = useMemo(() => timeOptions(group.quiet_end), [group.quiet_end]);

  const toggleChannel = (c: Channel, on: boolean) => setChannels((prev) => {
    const next = new Set(prev);
    if (on) next.add(c); else next.delete(c);
    return next;
  });

  const toggleCategory = (c: NotificationCategory) => setCategories((prev) => {
    const next = new Set(prev);
    if (next.has(c)) next.delete(c); else next.add(c);
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

    // The live selections plus every stored channel the screen does not show,
    // in CHANNELS order; sent only when that is not what is already stored.
    const hidden = group.channels.filter((c) => !LIVE_CHANNELS.includes(c as Channel));
    const nextChannels = CHANNELS.filter((c) => channels.has(c) || hidden.includes(c));
    if (!sameMembers(nextChannels, group.channels)) patch.channels = nextChannels;

    const nextCategories = NOTIFICATION_CATEGORIES.map((c) => c.key).filter((c) => categories.has(c));
    if (!sameMembers(nextCategories, group.categories)) patch.categories = nextCategories;

    const origMode: QuietMode = group.quiet_start !== null ? 'custom' : 'off';
    const nextStart = quietMode === 'custom' ? quietStart : null;
    const nextEnd = quietMode === 'custom' ? quietEnd : null;
    if (quietMode !== origMode || nextStart !== clock(group.quiet_start)
        || nextEnd !== clock(group.quiet_end)) {
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
    <NotificationModal
      eyebrow="Notification group" title="Delivery settings"
      description="Defaults every member inherits unless they set their own."
      onClose={onClose} busy={saving}
      footer={(
        <>
          <button className="btn-solid" type="submit" form={formId} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button className="mini-btn" type="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          {error && <span className="pf-error" role="alert">{error}</span>}
        </>
      )}>
      <form id={formId} onSubmit={submit}>
        <div className="ngd-section">Channels</div>
        <div className="pf-form">
          {LIVE_CHANNELS.map((c) => (
            <div className="full ngd-switch-row" key={c}>
              <span>{CHANNEL_LABELS[c]}</span>
              <Switch checked={channels.has(c)} label={CHANNEL_LABELS[c]} disabled={saving}
                      onChange={(v) => toggleChannel(c, v)} />
            </div>
          ))}
        </div>

        <div className="ngd-section">Categories</div>
        <div className="day-pills" role="group" aria-label="Categories">
          {NOTIFICATION_CATEGORIES.map((c) => (
            <button type="button" key={c.key} disabled={saving}
                    aria-pressed={categories.has(c.key)}
                    className={`mini-btn${categories.has(c.key) ? ' active' : ''}`}
                    onClick={() => toggleCategory(c.key)}>
              {c.label}
            </button>
          ))}
        </div>

        <div className="ngd-section">Quiet hours</div>
        <div className="pf-form">
          <ChoiceField label="Window" options={QUIET_CHOICES} value={quietMode}
                       onChange={setQuietMode} disabled={saving} />
          <div>
            <label htmlFor="ngd-timezone">Timezone</label>
            <ComboBox inputId="ngd-timezone" options={timezoneOptions()} value={timezone}
                      onChange={setTimezone} disabled={saving}
                      placeholder="Type to search timezones…" />
          </div>
          {quietMode === 'custom' && (
            <>
              <div>
                <label htmlFor="ngd-quiet-start">Start</label>
                <ComboBox inputId="ngd-quiet-start" options={startOptions} value={quietStart}
                          onChange={setQuietStart} disabled={saving}
                          placeholder="Select a time…" />
              </div>
              <div>
                <label htmlFor="ngd-quiet-end">End</label>
                <ComboBox inputId="ngd-quiet-end" options={endOptions} value={quietEnd}
                          onChange={setQuietEnd} disabled={saving}
                          placeholder="Select a time…" />
              </div>
            </>
          )}
        </div>

        <div className="ngd-section">Active days</div>
        <div className="day-pills" role="group" aria-label="Active days">
          {DAYS.map((d) => (
            <button type="button" key={d} disabled={saving}
                    aria-pressed={activeDays.has(d)}
                    className={`mini-btn${activeDays.has(d) ? ' active' : ''}`}
                    onClick={() => toggleDay(d)}>
              {DAY_LABELS[d]}
            </button>
          ))}
        </div>

        <div className="ngd-section">Behavior</div>
        <div className="pf-form">
          <ChoiceField className="full" label="When blocked" options={DND_CHOICES}
                       value={dndBehavior} onChange={setDndBehavior} disabled={saving} />
          <div className="full ngd-switch-row">
            <span>Urgent bypass</span>
            <Switch checked={urgentBypass} label="Urgent bypass" disabled={saving}
                    onChange={setUrgentBypass} />
          </div>
        </div>
      </form>
    </NotificationModal>
  );
}
