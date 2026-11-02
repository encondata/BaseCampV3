/**
 * CheckDeliveryModal — the Delivery log's dry run (GET /notifications/check).
 * Pick a person and a notification type and it explains what would happen
 * right now: whether the inbox row is written and whose switch decides it,
 * whether the email goes now, is held for the person's summary (until when,
 * and why) or does not go (and why), the address it would go to, the person's
 * switches and where each comes from, their schedule and whether it is open
 * right now, and whether the type is critical. For a type the account owner
 * always gets, a segmented choice models the owner's own copy or an admin's
 * copy, which stays in the inbox. It asks as soon as both pickers are set and
 * again on every change. Nothing is sent or written.
 *
 * "Critical type" describes the TYPE (it skips quiet hours, days off and the
 * summary), not this answer: an admin's copy of a security notice is critical
 * as a type and still is not emailed.
 */

import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';

import {
  ApiError, checkDelivery, listNotificationKinds, listNotificationRecipients,
  type DeliveryCheck, type NotificationKindInfo, type NotificationRecipient,
} from '../../lib/api';
import {
  ADDRESS_SOURCE_LABELS, reasonLabel, scheduleStateOf, shortWhen, switchSourceLabel,
} from '../../lib/deliveryLog';
import { categoryLabel } from '../../lib/notificationKinds';
import { formatDays, formatQuietHours } from '../../lib/notifications';
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
  return r.inbox === 'written'
    ? <><span className="chip c-blue">In inbox</span> · {source}</>
    // notify() keeps the row out only for a category turned off
    : <><span className="chip c-slate">Not in inbox</span> · {reasonLabel('category_off')} · {source}</>;
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
  return <>{chip}{to && ` ${to}`}</>;
}

/** "Inbox on (Company default) · Email off (Their choice)". */
function switchesLine(r: DeliveryCheck): string {
  const one = (name: string, s: DeliveryCheck['switches']['inbox']) =>
    `${name} ${s.on ? 'on' : 'off'} (${switchSourceLabel(s.source)})`;
  return `${one('Inbox', r.switches.inbox)} · ${one('Email', r.switches.email)}`;
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
              </dl>
            </section>
          </div>
        )}
      </div>
    </NotificationModal>
  );
}
