/**
 * Edit schedule: how an initiative's learning invites go out. By hand
 * (Send invites now) or on a schedule (days before the start, at a time of
 * day in the site's time zone), the days before the start that reminders go
 * out, when the work is due, and whether people added later are invited on
 * their own. Saving PUTs the whole schedule. Needs learning:change.
 */

import { useMemo, useState } from 'react';

import { putInitiativeSchedule, type ScheduleOut } from '../../lib/learning';
import { positiveInt } from '../../lib/learningDoc';
import { compareOrdinal } from '../../lib/naturalSort';
import ChipPicker from '../ChipPicker';
import ComboBox from '../ComboBox';
import { Switch } from '../Switch';
import { offsetLabel, tabErrorText, timeLabel } from './initiativeLearning';
import LearningModal from './LearningModal';

/** Reminder days the picker offers (the API allows up to 365). */
const REMINDER_CHOICES = Array.from({ length: 61 }, (_, i) => i);

/** Times of day, every 15 minutes. */
const TIME_CHOICES = Array.from({ length: 96 }, (_, i) =>
  `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`);

export default function ScheduleModal({ initiativeId, schedule, onClose, onSaved }: {
  initiativeId: string;
  schedule: ScheduleOut;
  onClose: () => void;
  onSaved: (saved: ScheduleOut) => void;
}) {
  const [mode, setMode] = useState(schedule.mode);
  const [daysText, setDaysText] = useState(String(schedule.send_offset_days));
  const [time, setTime] = useState(schedule.send_time);
  const [reminders, setReminders] = useState(schedule.reminder_offsets.map(String));
  const [dueText, setDueText] = useState(String(schedule.due_offset_days));
  const [lateAdds, setLateAdds] = useState(schedule.late_adds);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const days = positiveInt(daysText);
  const due = positiveInt(dueText);
  const scheduled = mode === 'scheduled';
  const daysBad = scheduled && days === null;
  const dueBad = due === null;
  const valid = !daysBad && !dueBad;

  const reminderOptions = useMemo(() => {
    const values = new Set([...REMINDER_CHOICES, ...schedule.reminder_offsets]);
    return Array.from(values).sort((a, b) => a - b)
      .map((n) => ({ value: String(n), label: offsetLabel(n) }));
  }, [schedule.reminder_offsets]);
  const timeOptions = useMemo(() => (TIME_CHOICES.includes(schedule.send_time)
    ? TIME_CHOICES : [...TIME_CHOICES, schedule.send_time].sort(compareOrdinal))
    .map((t) => ({ value: t, label: timeLabel(t) })), [schedule.send_time]);

  const save = async () => {
    if (!valid) return;
    setSaving(true);
    setError('');
    try {
      const saved = await putInitiativeSchedule(initiativeId, {
        mode,
        send_offset_days: days ?? schedule.send_offset_days,
        send_time: time,
        reminder_offsets: reminders.map(Number).sort((a, b) => b - a),
        due_offset_days: due as number,
        late_adds: lateAdds,
      });
      onSaved(saved);
    } catch (e) {
      setError(tabErrorText(e));
      setSaving(false);
    }
  };

  return (
    <LearningModal eyebrow="Learning" title="Edit schedule"
                   description="When people on this initiative get their invite and reminders, and when the training is due."
                   onClose={onClose} busy={saving}
                   footer={(
                     <>
                       <button type="button" className="btn-solid" onClick={() => void save()}
                               disabled={!valid || saving}>
                         {saving ? 'Saving…' : 'Save schedule'}
                       </button>
                       <button type="button" className="mini-btn" onClick={onClose} disabled={saving}>Cancel</button>
                       {error && <span className="pf-error" role="alert">{error}</span>}
                     </>
                   )}>
      <div className="lrn-sched">
        <div className="lrn-set">
          <span className="lrn-lbl">Invites</span>
          <div className="segmented" role="group" aria-label="How invites go out">
            <button type="button" aria-pressed={!scheduled} className={!scheduled ? 'on' : ''}
                    disabled={saving} onClick={() => setMode('manual')}>Send by hand</button>
            <button type="button" aria-pressed={scheduled} className={scheduled ? 'on' : ''}
                    disabled={saving} onClick={() => setMode('scheduled')}>Send on a schedule</button>
          </div>
          {!scheduled && (
            <p className="lrn-hint">Nothing goes out until you choose Send invites now on this tab.</p>
          )}
          {scheduled && (
            <>
              <div className="lrn-validity">
                <input className="lrn-num" inputMode="numeric" value={daysText} disabled={saving}
                       aria-label="Days before start" aria-invalid={daysBad}
                       onChange={(e) => setDaysText(e.target.value)} />
                <span className="lrn-unit">days before the start, at</span>
                <div className="lrn-time">
                  <ComboBox options={timeOptions} value={time} onChange={(v) => v && setTime(v)}
                            ariaLabel="Send time" disabled={saving} />
                </div>
                <span className="lrn-unit">site time</span>
              </div>
              {daysBad && <p className="pf-error" role="alert">Use at least 1 day before the start.</p>}
            </>
          )}
        </div>

        <div className="lrn-set">
          <span className="lrn-lbl">Reminders</span>
          <ChipPicker options={reminderOptions} selected={reminders}
                      onChange={(v) => setReminders(v)} disabled={saving}
                      ariaLabel="Add a reminder day" placeholder="Add a reminder day…"
                      note={reminders.length === 0 ? 'No reminders.' : 'Days before the start.'} />
        </div>

        <div className="lrn-set">
          <span className="lrn-lbl">Due</span>
          <div className="lrn-validity">
            <input className="lrn-num" inputMode="numeric" value={dueText} disabled={saving}
                   aria-label="Due days before start" aria-invalid={dueBad}
                   onChange={(e) => setDueText(e.target.value)} />
            <span className="lrn-unit">days before the start</span>
          </div>
          {dueBad && <p className="pf-error" role="alert">Due must be at least 1 day before the start.</p>}
        </div>

        <div className="lrn-toggle">
          <span>Invite people added later automatically</span>
          <Switch checked={lateAdds} onChange={setLateAdds} disabled={saving}
                  label="Invite people added later" />
        </div>
      </div>
    </LearningModal>
  );
}
