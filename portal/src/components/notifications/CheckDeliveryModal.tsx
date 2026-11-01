/**
 * CheckDeliveryModal — the Delivery log's dry run (GET /notifications/check).
 * Pick a person and a notification type and it explains what would happen
 * right now: whether the inbox row is written, whether the email goes now, is
 * held (until when, and why) or does not go (and why), the address it would go
 * to, and every group's verdict. For a type the account owner always gets, a
 * segmented choice models the owner's own copy or an admin's copy, which goes
 * through groups. It asks as soon as both pickers are set and again on every
 * change. Nothing is sent or written.
 *
 * "Always emailed" is said only of the owner's own copy (`owner_copy`), never
 * read off the category's `email_source`: an admin's copy of a security notice
 * still reports "always" there, but it is emailed through groups.
 *
 * An email stopped before any group is consulted (email off, the person's own
 * choice, no address…) lists the person's groups as "Not asked", with a note
 * saying why, rather than verdicts nobody acted on.
 */

import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';

import {
  ApiError, checkDelivery, listNotificationKinds, listNotificationRecipients,
  type DeliveryCheck, type DeliveryCheckGroup, type NotificationKindInfo, type NotificationRecipient,
} from '../../lib/api';
import { ADDRESS_SOURCE_LABELS, reasonLabel, shortWhen, verdictOf } from '../../lib/deliveryLog';
import { categoryLabel } from '../../lib/notificationKinds';
import { formatDays, formatQuietHours } from '../../lib/notifications';
import ComboBox, { type ComboOption } from '../ComboBox';
import DataTable, { type DataTableColumn, type DataTableRow } from '../DataTable';
import ChoiceField from './ChoiceField';
import NotificationModal from './NotificationModal';

type Copy = 'owner' | 'admin';

const COPY_CHOICES: { key: Copy; label: string }[] = [
  { key: 'owner', label: 'The account owner' },
  { key: 'admin', label: 'An admin copy' },
];

const OUTCOMES: Record<DeliveryCheck['outcome'], { label: string; chip: string }> = {
  now: { label: 'Sends now', chip: 'c-green' },
  held: { label: 'Held', chip: 'c-amber' },
  not_sent: { label: 'Not sent', chip: 'c-slate' },
};

const ERRORS: Record<string, string> = {
  person_not_found: 'That person no longer exists.',
  invalid_kind: 'That notification type is no longer registered.',
  forbidden: 'Only super admins and above can check delivery.',
};

const msgFor = (err: unknown): string =>
  err instanceof ApiError ? (ERRORS[err.code] ?? `Request failed (${err.code}).`) : 'Network error — try again.';

const GROUP_COLUMNS: DataTableColumn[] = [
  { key: 'group', label: 'Group' },
  { key: 'subscribed', label: 'Subscribed' },
  { key: 'email', label: 'Email' },
  { key: 'now', label: 'Now' },
  { key: 'earliest', label: 'Earliest send', mono: true },
];

/** When a group would let the email go: now when it is open, the time it
 *  opens when it is closed and defers, never when it skips; "—" for a group
 *  that was not asked (paused, not subscribed, no email). */
function earliestSend(g: DeliveryCheckGroup): string {
  if (g.verdict === 'open' || g.verdict === 'urgent_bypass') return 'Now';
  if (g.verdict === 'quiet_hours' || g.verdict === 'inactive_day') {
    return g.allowed_at ? shortWhen(g.allowed_at) : 'Never';
  }
  return '—';
}

/** The group's quiet hours and days, under its name. */
function schedule(g: DeliveryCheckGroup): string {
  const quiet = formatQuietHours(g.quiet_start, g.quiet_end, g.timezone);
  return `${quiet === '—' ? 'No quiet hours' : quiet} · ${formatDays(g.active_days)}`;
}

/** Why no group was asked, by the reason an email is not sent when the
 *  decision (the API's decide_email, whose checks run in order with the
 *  groups last) settles it before looking at any group. */
const NOT_ASKED_NOTES: Record<string, string> = {
  email_not_set_up: "Email isn't set up on this server, so no group is asked.",
  unregistered_kind: "This type isn't registered, so no group is asked.",
  kind_not_emailed: 'This type is never emailed, so no group is asked.',
  category_off: 'This person turned the category off, so no group is asked.',
  category_inbox_only: 'This person keeps the category in the inbox only, so no group is asked.',
  recipient_inactive: 'This person is archived or their account is disabled, so no group is asked.',
  no_address: 'This person has no email address, so no group is asked.',
};

/** The groups' Now cell when they were never asked. */
const NOT_ASKED = { label: 'Not asked', chip: 'c-slate' };

/** Why the groups were never asked about this email, or null when they were
 *  (it goes, waits, or the groups themselves stopped it). */
function notAskedNote(r: DeliveryCheck): string | null {
  if (r.outcome !== 'not_sent' || r.reason === null) return null;
  return Object.hasOwn(NOT_ASKED_NOTES, r.reason) ? NOT_ASKED_NOTES[r.reason] : null;
}

/** What the groups have to do with this email, above their table. */
function groupsNote(r: DeliveryCheck): string {
  const notAsked = notAskedNote(r);
  if (notAsked) return notAsked;
  if (r.owner_copy) return "The account owner's own copy is always emailed, whatever these groups say.";
  if (r.email_source === 'direct') return "This category's email follows the person's own choice, not their groups.";
  return `It is emailed when one of these groups covers ${categoryLabel(r.category)} with Email on, `
    + 'at the earliest time any of them allows.';
}

function inboxLine(r: DeliveryCheck): ReactNode {
  return r.inbox === 'written'
    ? <span className="chip c-blue">In inbox</span>
    // notify() keeps the row out only for a category turned off
    : <><span className="chip c-slate">Not in inbox</span> · {reasonLabel('category_off')}</>;
}

function emailLine(r: DeliveryCheck): ReactNode {
  const outcome = OUTCOMES[r.outcome];
  const chip = <span className={`chip ${outcome.chip}`}>{outcome.label}</span>;
  if (r.outcome === 'not_sent') return <>{chip}{r.reason && <> · {reasonLabel(r.reason)}</>}</>;
  const source = r.address_source ? ADDRESS_SOURCE_LABELS[r.address_source] : null;
  const to = r.address ? `to ${r.address}${source ? ` (${source})` : ''}` : null;
  if (r.outcome === 'held') {
    return (
      <>
        {chip} until {r.send_at ? shortWhen(r.send_at) : '—'}
        {r.reason && ` · ${reasonLabel(r.reason)}`}
        {to && ` · ${to}`}
      </>
    );
  }
  return <>{chip}{to && ` ${to}`}</>;
}

export default function CheckDeliveryModal({ onClose }: { onClose: () => void }) {
  const personFieldId = useId();
  const kindFieldId = useId();
  const [people, setPeople] = useState<NotificationRecipient[] | null>(null);
  const [kinds, setKinds] = useState<NotificationKindInfo[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [personId, setPersonId] = useState('');
  const [kind, setKind] = useState('');
  const [copy, setCopy] = useState<Copy>('owner');
  const [result, setResult] = useState<DeliveryCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    listNotificationRecipients()
      .then((r) => { if (alive) setPeople(r); })
      .catch(() => { if (alive) setLoadError("Couldn't load the people list."); });
    listNotificationKinds()
      .then((k) => { if (alive) setKinds(k); })
      .catch(() => { if (alive) setLoadError("Couldn't load the notification types."); });
    return () => { alive = false; };
  }, []);

  const kindInfo = kinds?.find((k) => k.kind === kind) ?? null;
  const copyApplies = kindInfo?.owner_always === true;
  const adminCopy = copyApplies && copy === 'admin';

  // Ask again on every change; an answer to an older question is dropped.
  // The last answer stays up, dimmed, until the new one lands, so the dialog
  // does not collapse and grow back on every pick.
  useEffect(() => {
    if (!personId || !kind) return undefined;
    let alive = true;
    setError('');
    setChecking(true);
    (adminCopy ? checkDelivery(personId, kind, false) : checkDelivery(personId, kind))
      .then((r) => { if (alive) setResult(r); })
      .catch((err: unknown) => {
        if (!alive) return;
        setResult(null);
        setError(msgFor(err));
      })
      .finally(() => { if (alive) setChecking(false); });
    return () => { alive = false; };
  }, [personId, kind, adminCopy]);

  const pickKind = (next: string) => {
    setKind(next);
    setCopy('owner');
  };

  const personOptions: ComboOption[] = useMemo(() => (people ?? []).map((p) => ({
    value: p.person_id, label: p.display_name, sub: p.job_title,
  })), [people]);
  const kindOptions: ComboOption[] = useMemo(() => (kinds ?? []).map((k) => ({
    value: k.kind, label: k.label, sub: categoryLabel(k.category),
  })), [kinds]);

  // An email stopped before any group was consulted: no verdict was acted on.
  const groupsAsked = result !== null && notAskedNote(result) === null;
  const groupRows: DataTableRow[] = (result?.groups ?? []).map((g) => {
    const verdict = groupsAsked ? verdictOf(g.verdict) : NOT_ASKED;
    return {
      key: g.group_id,
      cells: [
        <div key="group" className="cell-primary">
          <div className="pn"><b>{g.name}</b><span>{schedule(g)}</span></div>
        </div>,
        g.subscribed ? 'Yes' : 'No',
        g.email_channel ? 'Yes' : 'No',
        <span key="now" className={`chip ${verdict.chip}`}>{verdict.label}</span>,
        groupsAsked ? earliestSend(g) : '—',
      ],
    };
  });

  return (
    <NotificationModal
      eyebrow="Delivery log" title="Check delivery" wide onClose={onClose}
      description="What would happen right now if this person got this type of notification. Nothing is sent."
      footer={<button type="button" className="btn-solid" onClick={onClose}>Done</button>}>
      <div className="pf-form">
        <div>
          <label htmlFor={personFieldId}>Person</label>
          <ComboBox inputId={personFieldId} options={personOptions} value={personId}
                    onChange={setPersonId}
                    placeholder={people === null ? 'Loading people…' : 'Type a name…'} />
        </div>
        <div>
          <label htmlFor={kindFieldId}>Notification type</label>
          <ComboBox inputId={kindFieldId} options={kindOptions} value={kind} onChange={pickKind}
                    placeholder={kinds === null ? 'Loading types…' : 'Type to search…'} />
        </div>
        {copyApplies && (
          <ChoiceField className="full" label="Which copy" options={COPY_CHOICES}
                       value={copy} onChange={setCopy} />
        )}
        {loadError && <div className="pf-error full" role="alert">{loadError}</div>}
      </div>

      <div className="dlog-check">
        {error ? (
          <div className="pf-error" role="alert">{error}</div>
        ) : !result ? (
          checking
            ? <p className="cell-sub nm-hint" role="status">Checking…</p>
            : <p className="cell-sub nm-hint">Pick a person and a notification type.</p>
        ) : (
          <div className="dlog-check-result" aria-busy={checking}>
            <section className="rgm-summary" aria-label="Result">
              <div className="modal-section">Right now</div>
              <dl className="kv">
                <dt>Inbox</dt>
                <dd>{inboxLine(result)}</dd>
                <dt>Email</dt>
                <dd>{emailLine(result)}</dd>
              </dl>
            </section>

            <div className="modal-section">Groups</div>
            <p className="cell-sub nm-hint dlog-check-note">{groupsNote(result)}</p>
            <div className="dlog-check-groups">
              <DataTable ariaLabel="Groups" columns={GROUP_COLUMNS} rows={groupRows}
                         emptyText="Not in any notification group." />
            </div>
          </div>
        )}
      </div>
    </NotificationModal>
  );
}
