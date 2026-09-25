/**
 * TimeEntryEditModal — the only place a time entry is created or edited by
 * hand, and where a pending entry gets approved/rejected. `entry === null`
 * opens the modal in create mode (an admin adding a manual entry for
 * someone else); otherwise it edits the given entry.
 *
 * The API only requires `adjust_reason` on a PATCH whose body actually
 * carries a clock_in_at/clock_out_at/break_minutes key (routes/time.py's
 * `is_adjustment` check looks at which keys were SENT, not whether they
 * differ from the stored value) — so the patch payload only includes a
 * time field when it truly changed from the entry's original value, and
 * the Reason field only becomes required/highlighted in that case.
 *
 * Follows the modal-scrim/modal-card/modal-head/modal-body/modal-foot
 * conventions from components/sites/SiteEditModal.tsx.
 */

import { useState, type FormEvent } from 'react';

import ComboBox from '../ComboBox';
import {
  ApiError,
  approveTimeEntry,
  createTimeEntry,
  rejectTimeEntry,
  updateTimeEntry,
  type PunchOption,
  type TimeEntryItem,
  type WorkerOption,
} from '../../lib/api';

export const TIME_ERRORS: Record<string, string> = {
  already_clocked_in: "You're already clocked in.",
  not_clocked_in: "You're not clocked in.",
  invalid_break: 'Break time must be less than the total time worked.',
  invalid_range: 'Clock out must be after clock in.',
  adjust_reason_required: 'A reason is required when changing clock in/out or break time.',
  not_pending: 'This entry is no longer pending.',
  person_not_found: 'That person no longer exists.',
  initiative_not_found: 'That initiative no longer exists — pick another.',
  site_not_found: 'That site no longer exists — pick another.',
  time_entry_not_found: 'This time entry no longer exists.',
  too_many: 'More than 5,000 entries match. Narrow the filters and try again.',
  reason_required: 'Enter a reason for rejecting.',
  ids_or_filter: 'Something went wrong. Refresh the page and try again.',
  forbidden: 'You do not have permission to do that.',
};

export function mapTimeError(err: unknown, fallback: string): string {
  return err instanceof ApiError ? (TIME_ERRORS[err.code] ?? fallback) : 'Network error.';
}

/** ISO instant → the local value a `datetime-local` input expects
 *  (YYYY-MM-DDTHH:mm, local time — NOT toISOString, which is UTC). */
function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `datetime-local` value (interpreted by the browser as local time) →
 *  an ISO instant string for the wire. */
function localInputToIso(value: string): string | null {
  if (!value) return null;
  return new Date(value).toISOString();
}

interface Props {
  entry: TimeEntryItem | null; // null = create mode
  initiatives: PunchOption[];
  sites: PunchOption[];
  workers: WorkerOption[];     // create mode's person picker
  canApprove: boolean;         // can('time', 'change') — gates the footer's Approve/Reject
  /** 'reject' opens the modal with the reject reason field already showing —
   *  the Timesheet's row-level Reject action skips straight past the full
   *  edit form (still this same modal, per the house "no prompt()" rule). */
  initialMode?: 'edit' | 'reject';
  onClose: () => void;
  onSaved: () => Promise<void> | void; // parent refetches
}

export default function TimeEntryEditModal({
  entry, initiatives, sites, workers, canApprove, initialMode = 'edit', onClose, onSaved,
}: Props) {
  const isCreateMode = entry === null;

  const [personId, setPersonId] = useState(entry?.person_id ?? '');
  const [clockIn, setClockIn] = useState(() => isoToLocalInput(entry?.clock_in_at));
  const [clockOut, setClockOut] = useState(() => isoToLocalInput(entry?.clock_out_at));
  const [breakMinutes, setBreakMinutes] = useState(() => String(entry?.break_minutes ?? 0));
  const [initiativeId, setInitiativeId] = useState(entry?.initiative_id ?? '');
  const [siteId, setSiteId] = useState(entry?.site_id ?? '');
  const [notes, setNotes] = useState(entry?.notes ?? '');
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(initialMode === 'reject');
  const [rejectReason, setRejectReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const originalClockIn = isoToLocalInput(entry?.clock_in_at);
  const originalClockOut = isoToLocalInput(entry?.clock_out_at);
  const originalBreak = entry?.break_minutes ?? 0;

  // Clearing Clock out in edit mode is treated as "leave it unchanged" —
  // the API rejects an explicit clock_out_at: null (re-opening a closed
  // entry isn't supported), so a blanked field must never reach the patch
  // body. Only a *filled-in*, *different* value counts as a real change.
  const clockOutChanged = !isCreateMode && clockOut !== '' && clockOut !== originalClockOut;

  // Only meaningful in edit mode — a brand-new entry has no "original" to
  // diverge from, and the create endpoint takes no adjust_reason at all.
  const timeChanged = !isCreateMode && (
    clockIn !== originalClockIn
    || clockOutChanged
    || Number(breakMinutes || 0) !== originalBreak
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (timeChanged && !reason.trim()) {
      setError(TIME_ERRORS.adjust_reason_required);
      return;
    }

    setSaving(true);
    try {
      if (isCreateMode) {
        if (!personId) {
          setError('Select a person.');
          setSaving(false);
          return;
        }
        if (!clockIn || !clockOut) {
          setError('Clock in and clock out are both required.');
          setSaving(false);
          return;
        }
        const body: Record<string, unknown> = {
          person_id: personId,
          clock_in_at: localInputToIso(clockIn),
          clock_out_at: localInputToIso(clockOut),
        };
        if (initiativeId) body.initiative_id = initiativeId;
        if (siteId) body.site_id = siteId;
        if (breakMinutes.trim()) body.break_minutes = Number(breakMinutes);
        if (notes.trim()) body.notes = notes.trim();
        await createTimeEntry(body);
      } else {
        const patch: Record<string, unknown> = {};
        if (clockIn !== originalClockIn) patch.clock_in_at = localInputToIso(clockIn);
        if (clockOutChanged) patch.clock_out_at = localInputToIso(clockOut);
        if (Number(breakMinutes || 0) !== originalBreak) {
          patch.break_minutes = Number(breakMinutes || 0);
        }
        if (initiativeId !== (entry!.initiative_id ?? '')) {
          patch.initiative_id = initiativeId || null;
        }
        if (siteId !== (entry!.site_id ?? '')) {
          patch.site_id = siteId || null;
        }
        if (notes.trim() !== (entry!.notes ?? '')) patch.notes = notes.trim();
        if (timeChanged) patch.adjust_reason = reason.trim();

        if (Object.keys(patch).length === 0) {
          onClose();
          return;
        }
        await updateTimeEntry(entry!.id, patch);
      }
      await onSaved();
      onClose();
    } catch (err) {
      setError(mapTimeError(err, 'Could not save — try again.'));
    } finally {
      setSaving(false);
    }
  };

  const doApprove = async () => {
    if (!entry) return;
    setSaving(true);
    setError('');
    try {
      await approveTimeEntry(entry.id);
      await onSaved();
      onClose();
    } catch (err) {
      setError(mapTimeError(err, 'Could not approve — try again.'));
    } finally {
      setSaving(false);
    }
  };

  const doReject = async () => {
    if (!entry) return;
    if (!rejectReason.trim()) {
      setError('A rejection reason is required.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await rejectTimeEntry(entry.id, rejectReason.trim());
      await onSaved();
      onClose();
    } catch (err) {
      setError(mapTimeError(err, 'Could not reject — try again.'));
    } finally {
      setSaving(false);
    }
  };

  const showReview = !isCreateMode && canApprove && entry!.status === 'pending';
  const title = isCreateMode ? 'Add time entry' : `Edit — ${entry!.person_name}`;

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget && !saving) onClose();
    }}>
      <div className="modal-card">
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose} disabled={saving}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form onSubmit={(e) => void submit(e)}>
          <div className="modal-body">
            {isCreateMode && (
              <>
                <div className="modal-section">Person</div>
                <div className="pf-form">
                  <div className="full">
                    <label>Person *</label>
                    <ComboBox
                      placeholder="Type to search people…"
                      value={personId}
                      disabled={saving}
                      onChange={setPersonId}
                      options={workers.map((w) => ({ value: w.person_id, label: w.display_name }))}
                    />
                  </div>
                </div>
              </>
            )}

            <div className="modal-section">Time</div>
            <div className="pf-form">
              <div>
                <label htmlFor="te-clock-in">Clock in *</label>
                <input id="te-clock-in" type="datetime-local" value={clockIn}
                       disabled={saving} required
                       onChange={(e) => setClockIn(e.target.value)} />
              </div>
              <div>
                <label htmlFor="te-clock-out">Clock out{isCreateMode ? ' *' : ''}</label>
                <input id="te-clock-out" type="datetime-local" value={clockOut}
                       disabled={saving} required={isCreateMode}
                       onChange={(e) => setClockOut(e.target.value)} />
              </div>
              <div>
                <label htmlFor="te-break">Break (minutes)</label>
                <input id="te-break" type="number" min={0} value={breakMinutes}
                       disabled={saving}
                       onChange={(e) => setBreakMinutes(e.target.value)} />
              </div>
            </div>

            {!isCreateMode && (
              <div className="pf-form">
                <div className={`full${timeChanged ? ' te-reason-highlight' : ''}`}>
                  <label htmlFor="te-reason">
                    Reason for change{timeChanged ? ' *' : ''}
                  </label>
                  <input id="te-reason" value={reason} disabled={saving}
                         aria-required={timeChanged}
                         placeholder={timeChanged
                           ? 'Required — explain the adjustment'
                           : 'Only needed if you change the times or break above'}
                         onChange={(e) => setReason(e.target.value)} />
                </div>
              </div>
            )}

            <div className="modal-section">Assignment</div>
            <div className="pf-form">
              <div>
                <label>Initiative</label>
                <ComboBox
                  placeholder="Type to search initiatives…"
                  value={initiativeId}
                  clearable
                  disabled={saving}
                  onChange={setInitiativeId}
                  options={initiatives.map((i) => ({ value: i.id, label: i.name }))}
                />
              </div>
              <div>
                <label>Site</label>
                <ComboBox
                  placeholder="Type to search sites…"
                  value={siteId}
                  clearable
                  disabled={saving}
                  onChange={setSiteId}
                  options={sites.map((s) => ({ value: s.id, label: s.name }))}
                />
              </div>
            </div>

            <div className="modal-section">Notes</div>
            <div className="pf-form">
              <div className="full">
                <textarea aria-label="Notes" rows={3} value={notes} disabled={saving}
                          onChange={(e) => setNotes(e.target.value)} />
              </div>
            </div>

            {showReview && rejecting && (
              <>
                <div className="modal-section">Reject this entry</div>
                <div className="pf-form">
                  <div className="full">
                    <label htmlFor="te-reject-reason">Rejection reason *</label>
                    <input id="te-reject-reason" value={rejectReason} disabled={saving}
                           onChange={(e) => setRejectReason(e.target.value)}
                           onKeyDown={(e) => {
                             // This input sits inside the modal's single
                             // <form> alongside the edit fields — a plain
                             // Enter here would trigger the form's own
                             // submit() instead, which no-ops on an empty
                             // patch (nothing but the reason changed) and
                             // silently discards whatever was typed. Route
                             // Enter to the actual reject action instead.
                             if (e.key === 'Enter') {
                               e.preventDefault();
                               void doReject();
                             }
                           }} />
                  </div>
                </div>
              </>
            )}
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={saving}>
              {saving ? 'Saving…' : (isCreateMode ? 'Add entry' : 'Save')}
            </button>
            <button className="mini-btn" type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            {showReview && !rejecting && (
              <>
                <button className="mini-btn" type="button" disabled={saving}
                        onClick={() => void doApprove()}>
                  Approve
                </button>
                <button className="mini-btn danger" type="button" disabled={saving}
                        onClick={() => setRejecting(true)}>
                  Reject
                </button>
              </>
            )}
            {showReview && rejecting && (
              <>
                <button className="mini-btn danger" type="button"
                        disabled={saving || !rejectReason.trim()}
                        onClick={() => void doReject()}>
                  Confirm reject
                </button>
                <button className="mini-btn" type="button" disabled={saving}
                        onClick={() => setRejecting(false)}>
                  Cancel reject
                </button>
              </>
            )}
            {error && <span className="pf-error">{error}</span>}
          </div>
        </form>
      </div>
    </div>
  );
}
