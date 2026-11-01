/**
 * OverrideEditorModal — per-member override editor opened from
 * MembersPanel's row Edit action, and (through `onSave`) the self-service
 * editor on /me › Notifications. Every setting is an explicit inherit-or-custom
 * choice in the house segmented control — "Group default" / "Custom", or for
 * quiet hours "Group default" / "None" / "Custom", for When blocked "Group
 * default" / "Defer" / "Skip", for Urgent bypass "Group default" / "On" /
 * "Off" — with the group's own value as a hint under it, so inheritance stays
 * legible rather than an implicit "blank means inherit". Diffs each field's
 * choice+value against the member's loaded overrides so the PATCH carries
 * only what changed, with an explicit `null` for anything reset back to
 * inherit (the PATCH distinguishes an absent field from one explicitly set to
 * null). Channels that have no switch (Text, Push and Web cannot send; Email
 * for a member with no address) are never lost by an edit that leaves the list
 * alone — the list is then not sent at all. When the list does change, the
 * saved list is the switches' selections plus the stored no-switch channels
 * the member can still receive, since the API refuses any other.
 */

import { useId, useMemo, useState, type FormEvent } from 'react';

import {
  ApiError, updateNotificationMember,
  type NotificationGroupDetail, type NotificationMember, type NotificationMemberOverrides,
} from '../../lib/api';
import {
  CHANNELS, CHANNEL_LABELS, DAYS, LIVE_CHANNELS, canForChannel, formatDays, formatQuietHours,
  liveChannels, timezoneOptions, type Channel, type Day,
} from '../../lib/notifications';
import { timeOptions } from '../../lib/timeChoices';
import ComboBox from '../ComboBox';
import { Switch } from '../Switch';
import { NO_EMAIL } from './ChannelChips';
import ChoiceField from './ChoiceField';
import NotificationModal from './NotificationModal';

type Mode = 'default' | 'custom';
type QuietMode = 'default' | 'none' | 'custom';
type DndChoice = 'default' | 'defer' | 'skip';
type UrgentChoice = 'default' | 'on' | 'off';

const GROUP_DEFAULT = { key: 'default', label: 'Group default' } as const;

const MODE_CHOICES: { key: Mode; label: string }[] = [
  GROUP_DEFAULT,
  { key: 'custom', label: 'Custom' },
];
const QUIET_CHOICES: { key: QuietMode; label: string }[] = [
  GROUP_DEFAULT,
  { key: 'none', label: 'None' },
  { key: 'custom', label: 'Custom' },
];
const DND_CHOICES: { key: DndChoice; label: string }[] = [
  GROUP_DEFAULT,
  { key: 'defer', label: 'Defer' },
  { key: 'skip', label: 'Skip' },
];
const URGENT_CHOICES: { key: UrgentChoice; label: string }[] = [
  GROUP_DEFAULT,
  { key: 'on', label: 'On' },
  { key: 'off', label: 'Off' },
];

const DAY_LABELS: Record<Day, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
};

const DND_LABELS: Record<string, string> = {
  defer: 'Defer until window opens',
  skip: 'Skip entirely',
};

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

/** The API's "HH:MM:SS" as the pickers' "HH:MM"; null stays null. */
const clock = (t: string | null): string | null => (t === null ? null : t.slice(0, 5));

const dndChoiceOf = (v: string | null): DndChoice => (v === null ? 'default' : v === 'skip' ? 'skip' : 'defer');
const urgentChoiceOf = (v: boolean | null): UrgentChoice => (v === null ? 'default' : v ? 'on' : 'off');

export default function OverrideEditorModal({ group, member, onClose, onSaved, onSave }: {
  group: NotificationGroupDetail;
  member: NotificationMember;
  onClose: () => void;
  onSaved: () => void;
  /** When given, called with the diffed patch instead of the admin PATCH
   *  (updateNotificationMember) — the self-service /me/notification-
   *  groups/{id}/overrides endpoint reuses this same editor + diffing via
   *  this hook, under its own "My settings" header. Default (admin)
   *  behavior is unchanged when omitted. */
  onSave?: (body: Partial<NotificationMemberOverrides>) => Promise<unknown>;
}) {
  const ov = member.overrides;
  const formId = useId();

  // The channels with a switch: the ones that can send, that this member can receive.
  const shownChannels = CHANNELS.filter((c) => LIVE_CHANNELS.includes(c) && canForChannel(member, c));

  const [channelsMode, setChannelsMode] = useState<Mode>(ov.channels === null ? 'default' : 'custom');
  const [channelsCustom, setChannelsCustom] = useState<Set<Channel>>(
    () => new Set(shownChannels.filter((c) => (ov.channels ?? []).includes(c))));

  const [quietMode, setQuietMode] = useState<QuietMode>(
    ov.quiet_mode === null ? 'default' : (ov.quiet_mode as QuietMode));
  const [quietStart, setQuietStart] = useState(clock(ov.quiet_start) ?? '');
  const [quietEnd, setQuietEnd] = useState(clock(ov.quiet_end) ?? '');

  const [timezoneMode, setTimezoneMode] = useState<Mode>(ov.timezone === null ? 'default' : 'custom');
  const [timezoneCustom, setTimezoneCustom] = useState(ov.timezone ?? group.timezone);

  const [daysMode, setDaysMode] = useState<Mode>(ov.active_days === null ? 'default' : 'custom');
  const [daysCustom, setDaysCustom] = useState<Set<Day>>(
    () => new Set((ov.active_days ?? []) as Day[]));

  const [dnd, setDnd] = useState<DndChoice>(dndChoiceOf(ov.dnd_behavior));
  const [urgent, setUrgent] = useState<UrgentChoice>(urgentChoiceOf(ov.urgent_bypass));

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const startOptions = useMemo(() => timeOptions(ov.quiet_start), [ov.quiet_start]);
  const endOptions = useMemo(() => timeOptions(ov.quiet_end), [ov.quiet_end]);

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

  // The group's own values, as the hints under each control.
  const groupChannelsLabel = liveChannels(group.channels).map((c) => CHANNEL_LABELS[c]).join(', ')
    || NO_EMAIL;
  const groupQuietLabel = group.quiet_start !== null && group.quiet_end !== null
    ? formatQuietHours(group.quiet_start, group.quiet_end, group.timezone) : 'None';
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

    // Channels. A list left alone is never sent: the server keeps what is
    // stored, hidden channels included. "Left alone" is the Group default |
    // Custom choice and the switches matching what is stored for the channels
    // that have a switch. When the list does change it is the switches'
    // selections plus the stored channels with no switch that the member can
    // still receive — the API refuses a channel outside their capabilities
    // (Text needs a phone, Push and Web an account, Email an address) with a
    // 422 channel_unavailable, so a stale one is dropped here instead of
    // failing the whole save.
    const storedChannels = ov.channels ?? [];
    const selectedChannels = CHANNELS.filter((c) => channelsCustom.has(c));
    const storedShown = shownChannels.filter((c) => storedChannels.includes(c));
    const channelsChanged = channelsMode === 'default'
      ? ov.channels !== null
      : (ov.channels === null || !sameArr(selectedChannels, storedShown));
    if (channelsChanged) {
      const kept = storedChannels.filter((c) => !shownChannels.includes(c as Channel)
        && canForChannel(member, c as Channel));
      patch.channels = channelsMode === 'default'
        ? null : CHANNELS.filter((c) => channelsCustom.has(c) || kept.includes(c));
    }

    const nextQuietMode = quietMode === 'default' ? null : quietMode;
    const nextQuietStart = quietMode === 'custom' ? quietStart : null;
    const nextQuietEnd = quietMode === 'custom' ? quietEnd : null;
    if (nextQuietMode !== ov.quiet_mode
        || nextQuietStart !== clock(ov.quiet_start)
        || nextQuietEnd !== clock(ov.quiet_end)) {
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

    if (dnd !== dndChoiceOf(ov.dnd_behavior)) patch.dnd_behavior = dnd === 'default' ? null : dnd;

    if (urgent !== urgentChoiceOf(ov.urgent_bypass)) {
      patch.urgent_bypass = urgent === 'default' ? null : urgent === 'on';
    }

    setSaving(true);
    try {
      if (onSave) await onSave(patch);
      else await updateNotificationMember(group.id, member.person_id, patch);
      onSaved();
    } catch (err) {
      setError(msgFor(err));
    } finally {
      setSaving(false);
    }
  };

  const self = onSave !== undefined;
  const firstName = member.display_name.trim().split(/\s+/)[0] || member.display_name;

  return (
    <NotificationModal
      eyebrow={self ? 'Your settings' : 'Notification group'}
      title={self ? `My settings — ${group.name}` : `Overrides — ${member.display_name}`}
      description={self
        ? 'Anything on Group default follows the group.'
        : `${firstName}'s own settings for this group. Anything on Group default follows the group.`}
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
      <form id={formId} className="ov-body" onSubmit={submit}>
        <div className="pf-form">
          <ChoiceField className="full" label="Channels" options={MODE_CHOICES} value={channelsMode}
                       onChange={setChannelsMode} disabled={saving}
                       hint={`Group default: ${groupChannelsLabel}`} />
          {channelsMode === 'custom' && (
            <>
              {shownChannels.map((c) => (
                <div className="full ngd-switch-row" key={c}>
                  <span>{CHANNEL_LABELS[c]}</span>
                  <Switch checked={channelsCustom.has(c)} label={CHANNEL_LABELS[c]} disabled={saving}
                          onChange={(v) => toggleChannel(c, v)} />
                </div>
              ))}
              {channelsCustom.size === 0 && (
                <p className="full cell-sub nm-hint">
                  {self ? 'You will get no email from this group.'
                    : 'This member will get no email from this group.'}
                </p>
              )}
            </>
          )}
        </div>

        <div className="pf-form">
          <ChoiceField className="full" label="Active days" options={MODE_CHOICES} value={daysMode}
                       onChange={setDaysMode} disabled={saving}
                       hint={`Group default: ${groupDaysLabel}`} />
          {daysMode === 'custom' && (
            <div className="full day-pills" role="group" aria-label="Custom days">
              {DAYS.map((d) => (
                <button type="button" key={d} disabled={saving}
                        aria-pressed={daysCustom.has(d)}
                        className={`mini-btn${daysCustom.has(d) ? ' active' : ''}`}
                        onClick={() => toggleDay(d)}>
                  {DAY_LABELS[d]}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="pf-form">
          <ChoiceField className="full" label="Quiet hours" options={QUIET_CHOICES} value={quietMode}
                       onChange={setQuietMode} disabled={saving}
                       hint={`Group default: ${groupQuietLabel}`} />
          {quietMode === 'custom' && (
            <>
              <div>
                <label htmlFor="ov-quiet-start">Start</label>
                <ComboBox inputId="ov-quiet-start" options={startOptions} value={quietStart}
                          onChange={setQuietStart} disabled={saving}
                          placeholder="Select a time…" />
              </div>
              <div>
                <label htmlFor="ov-quiet-end">End</label>
                <ComboBox inputId="ov-quiet-end" options={endOptions} value={quietEnd}
                          onChange={setQuietEnd} disabled={saving}
                          placeholder="Select a time…" />
              </div>
            </>
          )}
        </div>

        <div className="pf-form">
          <ChoiceField className="full" label="Timezone" options={MODE_CHOICES} value={timezoneMode}
                       onChange={setTimezoneMode} disabled={saving}
                       hint={`Group default: ${group.timezone}`} />
          {timezoneMode === 'custom' && (
            <div className="full">
              <ComboBox ariaLabel="Timezone" options={timezoneOptions()} value={timezoneCustom}
                        onChange={setTimezoneCustom} disabled={saving}
                        placeholder="Type to search timezones…" />
            </div>
          )}
        </div>

        <div className="pf-form">
          <ChoiceField className="full" label="When blocked" options={DND_CHOICES} value={dnd}
                       onChange={setDnd} disabled={saving}
                       hint={`Group default: ${groupDndLabel}`} />
        </div>

        <div className="pf-form">
          <ChoiceField className="full" label="Urgent bypass" options={URGENT_CHOICES} value={urgent}
                       onChange={setUrgent} disabled={saving}
                       hint={`Group default: ${groupUrgentLabel}`} />
        </div>
      </form>
    </NotificationModal>
  );
}
