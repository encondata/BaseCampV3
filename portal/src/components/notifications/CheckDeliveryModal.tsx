/**
 * CheckDeliveryModal — the Delivery log's dry run (GET /notifications/check).
 * Pick a person and a notification type and it explains what would happen
 * right now: whether the inbox row is written and whose switch decides it,
 * whether the email goes now, is held for the person's summary (until when,
 * and why) or does not go (and why), the address it would go to, the person's
 * switches and where each comes from, their schedule and whether it is open
 * right now, and whether the type is critical. A project plan notice is
 * emailed directly when the plan sends it, never held by the schedule, so its
 * Email line says "Sent directly" and a note under the rows says when that is.
 * For a type someone can watch
 * for, a Watching row lists the person's watches that would hear it, a line
 * each (the thing, its events, whose watch it is), and a note under the rows
 * says that reaching them for a particular thing also depends on their access
 * to it. For a type the account owner always gets, a segmented choice models
 * the owner's own copy or an admin's copy, which stays in the inbox. It asks as
 * soon as both pickers are set and again on every change. Nothing is sent or
 * written.
 *
 * "Critical type" describes the TYPE (it skips quiet hours, days off and the
 * summary), not this answer: an admin's copy of a security notice is critical
 * as a type and still is not emailed.
 */

import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';

import {
  ApiError, checkDelivery, listNotificationKinds, listNotificationRecipients,
  type CheckWatch, type DeliveryCheck, type NotificationKindInfo, type NotificationRecipient,
} from '../../lib/api';
import {
  ADDRESS_SOURCE_LABELS, AFTER_SUMMARY_LABEL, reasonLabel, scheduleStateOf, shortWhen,
  switchSourceLabel,
} from '../../lib/deliveryLog';
import { categoryLabel } from '../../lib/notificationKinds';
import { formatDays, formatQuietHours } from '../../lib/notifications';
import { THING_LABELS, eventsText } from '../../lib/watches';
import ComboBox, { type ComboOption } from '../ComboBox';
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
  direct: { label: 'Sent directly', chip: 'c-green' },
};

const ERRORS: Record<string, string> = {
  person_not_found: 'That person no longer exists.',
  invalid_kind: 'That notification type is no longer registered.',
  forbidden: 'Only super admins and above can check delivery.',
};

const msgFor = (err: unknown): string =>
  err instanceof ApiError ? (ERRORS[err.code] ?? `Request failed (${err.code}).`) : 'Network error — try again.';

function inboxLine(r: DeliveryCheck): ReactNode {
  const source = switchSourceLabel(r.inbox_source);
  if (r.inbox === 'written') return <><span className="chip c-blue">In inbox</span> · {source}</>;
  // a category turned off (and whose switch that is), or for a project plan
  // notice no portal account or an archived person
  const why = r.inbox_reason ?? 'category_off';
  return (
    <>
      <span className="chip c-slate">Not in inbox</span> · {reasonLabel(why)}
      {why === 'category_off' && <> · {source}</>}
    </>
  );
}

function emailLine(r: DeliveryCheck): ReactNode {
  const outcome = OUTCOMES[r.outcome];
  const chip = <span className={`chip ${outcome.chip}`}>{outcome.label}</span>;
  if (r.outcome === 'not_sent') return <>{chip}{r.reason && <> · {reasonLabel(r.reason)}</>}</>;
  const source = r.address_source ? ADDRESS_SOURCE_LABELS[r.address_source] : null;
  const to = r.address ? `to ${r.address}${source ? ` (${source})` : ''}` : null;
  if (r.outcome === 'held') {
    // the email waits for the person's one summary, due at summary_at
    return (
      <>
        {chip} until {r.summary_at ? shortWhen(r.summary_at) : '—'}
        {r.reason && ` · ${reasonLabel(r.reason)}`}
        {to && ` · ${to}`}
      </>
    );
  }
  // In the last hour before they are back online it goes now: that morning's summary has gone
  return <>{chip}{to && ` ${to}`}{r.after_summary && ` · ${AFTER_SUMMARY_LABEL}`}</>;
}

/** "Inbox on (Company default) · Email off (Their choice)". Email needs Inbox:
 *  while Inbox is off the API reports Email off whatever the person's own Email
 *  value is, and its source says where that value comes from, not what turned
 *  Email off (turning a category off in /me writes only the Inbox value, so the
 *  Email source then reads "default"). So with Inbox off the Email part names
 *  no source: "Email off (needs Inbox)". */
function switchesLine(r: DeliveryCheck): string {
  const { inbox, email } = r.switches;
  const one = (name: string, s: DeliveryCheck['switches']['inbox']) =>
    `${name} ${s.on ? 'on' : 'off'} (${switchSourceLabel(s.source)})`;
  return `${one('Inbox', inbox)} · ${inbox.on ? one('Email', email) : 'Email off (needs Inbox)'}`;
}

/** "America/Chicago · Mon–Fri · 9:00 PM – 7:00 AM CT · now In quiet hours". */
function scheduleLine(r: DeliveryCheck): ReactNode {
  const { timezone, days, quiet_start: start, quiet_end: end, state } = r.schedule;
  const quiet = formatQuietHours(start, end, timezone);
  const now = scheduleStateOf(state);
  return (
    <>
      {timezone} · {formatDays(days)} · {quiet === '—' ? 'No quiet hours' : quiet} · now{' '}
      <span className={`chip ${now.chip}`}>{now.label}</span>
    </>
  );
}

const NO_WATCHES = 'Nothing that hears this type';
const DIRECT_NOTE = 'Project plan notices go straight to the person: a reminder at the plan\'s '
  + 'send time, an assignment notice when it is made. Their schedule never holds one, and a plan '
  + 'with Email assignees off sends no email.';
const ACCESS_NOTE = 'Whether it reaches them for a particular thing also depends on their access to it.';

/** One watch of the person that would hear the type: "Initiative A · All events ·
 *  Their own", "Everything · Truck status changed · Group A". The thing is its
 *  name (Everything for an Everything watch), the events are their labels (or
 *  All events), and the last part is whose watch it is: theirs, or a group's
 *  name. A name the API left out reads as a dash, as in the watch lists. */
function watchLine(watch: CheckWatch, kinds: NotificationKindInfo[]): string {
  const thing = watch.thing === 'everything' ? THING_LABELS.everything : (watch.thing_name ?? '—');
  const via = watch.via.type === 'group' ? (watch.via.name ?? '—') : 'Their own';
  return `${thing} · ${eventsText(watch.kinds, kinds)} · ${via}`;
}

/** A person has one watch of their own on a thing, and so has each group. */
const watchKey = (w: CheckWatch): string =>
  `${w.via.type}:${w.via.id ?? ''}:${w.thing}:${w.thing_id ?? ''}`;

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
                <dt>Their switches</dt>
                <dd>{switchesLine(result)}</dd>
                <dt>Their schedule</dt>
                <dd>{scheduleLine(result)}</dd>
                <dt>Critical type</dt>
                <dd>{result.critical ? 'Yes — skips quiet hours and the summary' : 'No'}</dd>
                {result.watches && (
                  <>
                    <dt>Watching</dt>
                    <dd>
                      {result.watches.length === 0
                        ? NO_WATCHES
                        : result.watches.map((w) => (
                          <div key={watchKey(w)}>{watchLine(w, kinds ?? [])}</div>
                        ))}
                    </dd>
                  </>
                )}
              </dl>
              {result.watches && <p className="cell-sub nm-hint">{ACCESS_NOTE}</p>}
              {result.category === 'plans' && <p className="cell-sub nm-hint">{DIRECT_NOTE}</p>}
            </section>
          </div>
        )}
      </div>
    </NotificationModal>
  );
}
