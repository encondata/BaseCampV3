/**
 * System settings › Project plans (/settings/project-plans): the defaults
 * every project plan inherits live unless it sets its own, and the calendar
 * a new plan copies (spec Settings). Four `.set-section` cards:
 *  - Scheduling: Honor constraints, critical slack in days (fractions
 *    allowed), default task mode, default duration, Show times.
 *  - Default calendar: CalendarEditor (Plan settings' own).
 *  - Completion rules: what completing a summary task, and a task with open
 *    predecessors, does.
 *  - Reminders: on/off, the days before due (1 to 5, a ChipPicker), on the
 *    due day, overdue cadence, send time (a native time field, so inside a
 *    `.pf-form`), and the four notice switches.
 *
 * The form is lib/plans/systemSettings' (LearningSettings' shape): it shows
 * exactly what GET /system/project-plans returns, checks the draft with
 * Plan settings' rules, and PUTs only the keys that changed (a changed group
 * or calendar whole). Save + Discard; a refusal stays by Save with its
 * reason. While a change can't be saved, a note by Save names the first
 * field to fix ("Fix “Default duration” above.") with "Go to it", which
 * brings the first `aria-invalid` field into view and focuses it.
 * Read-only without settings:change (the Settings page says so).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import ChipPicker from '../../components/ChipPicker';
import CalendarEditor from '../../components/plans/CalendarEditor';
import { Choice, choiceOptions } from '../../components/plans/SettingChoice';
import { Switch } from '../../components/Switch';
import { useToast } from '../../lib/notificationsContext';
import {
  getProjectPlanSettings, putProjectPlanSettings, type ProjectPlanSettings as Settings,
} from '../../lib/plans/api';
import { SETTING_LABELS, planErrorText } from '../../lib/plans/errors';
import {
  COMPLETION_HINTS, MAX_OFFSETS, OVERDUE_CADENCES, PREDECESSOR_RULES, REMINDER_HINTS, SUBTASK_RULES, TASK_MODES,
} from '../../lib/plans/settingsForm';
import {
  OFFSET_OPTIONS, evaluate, fixHint, isDirty, isValid, offsetDays, toDraft, type ReminderDraft,
  type SystemSettingsDraft,
} from '../../lib/plans/systemSettings';
import '../../styles/directory.css';   // .segmented, .mini-btn
import '../../styles/plans.css';       // .pln-set-choice, CalendarEditor, .pln-sys-*
import '../../styles/profile.css';     // .pf-form, .pf-error, .btn-solid
import '../../styles/settings.css';    // .set-section, .set-row, .switch

const CALENDAR_HINT = 'New plans start with this calendar; existing plans keep their own.';
type ReminderSwitch = 'enabled' | 'on_due_day' | 'use_finish_without_deadline' | 'notify_on_assign'
  | 'overdue_to_owner' | 'email_assignees';

/** One setting: its name and line on the left (and what's wrong), the control on the right. */
function Setting({ id, label, hint, error, children }: {
  id: string; label: string; hint?: string; error?: string; children: ReactNode;
}) {
  return (
    <div className="set-row pln-sys-line">
      <div className="set-label">
        <b id={`${id}-label`}>{label}</b>
        {hint && <span id={`${id}-hint`}>{hint}</span>}
        {error && <p className="pf-error pln-sys-error" role="alert">{error}</p>}
      </div>
      <div className="pln-sys-control">{children}</div>
    </div>
  );
}

/** A card: its heading and line, then its settings. */
function Card({ id, title, hint, children }: { id: string; title: string; hint: ReactNode; children: ReactNode }) {
  return (
    <section className="set-section" aria-labelledby={`${id}-title`}>
      <div className="set-head">
        <h3 id={`${id}-title`}>{title}</h3>
        {hint}
      </div>
      {children}
    </section>
  );
}

export default function ProjectPlanSettings({ canChange }: { canChange: boolean }) {
  const toast = useToast();
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<SystemSettingsDraft | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const formRef = useRef<HTMLFormElement>(null);

  const load = useCallback(() => {
    setFailed(false);
    getProjectPlanSettings()
      .then((s) => { setSaved(s); setDraft(toDraft(s)); })
      .catch(() => setFailed(true));
  }, []);
  useEffect(() => { load(); }, [load]);

  const result = useMemo(() => (saved && draft ? evaluate(draft, saved) : null), [saved, draft]);

  if (failed) {
    return (
      <div className="pln-sys">
        <section className="set-section">
          <div className="pln-sys-pad pln-sys-failed" role="alert">
            <span>Couldn’t load the project plan settings.</span>
            <button type="button" className="mini-btn" onClick={load}>Try again</button>
          </div>
        </section>
      </div>
    );
  }
  if (!saved || !draft || !result) {
    return <div className="pln-sys"><section className="set-section"><p className="set-note pln-sys-pad">Loading…</p></section></div>;
  }

  const locked = !canChange || saving;
  const dirty = isDirty(result);
  const valid = isValid(result);
  const errors = result.errors;
  const fix = fixHint(errors, draft);

  /** The first field an error is about, into view and focused (the fields
   *  are in the order fixHint counts them). */
  const jumpToError = () => {
    const field = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (!field) return;
    field.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    field.focus({ preventScroll: true });
  };

  const set = (patch: Partial<SystemSettingsDraft>) => {
    setDraft((d) => d && { ...d, ...patch });
    setError('');
  };
  const setReminder = <K extends keyof ReminderDraft>(key: K, value: ReminderDraft[K]) => {
    setDraft((d) => d && { ...d, reminders: { ...d.reminders, [key]: value } });
    setError('');
  };

  const save = async () => {
    if (!valid || !dirty || saving) return;
    setSaving(true);
    setError('');
    try {
      const next = await putProjectPlanSettings(result.patch);
      setSaved(next);
      setDraft(toDraft(next));
      toast('Project plan settings saved');
    } catch (err) {
      setError(planErrorText(err));
    } finally {
      setSaving(false);
    }
  };
  const discard = () => {
    setDraft(toDraft(saved));
    setError('');
  };

  const reminderSwitch = (key: ReminderSwitch) => {
    const label = SETTING_LABELS[`reminders.${key}`];
    return (
      <Setting id={`pps-${key}`} label={label} hint={REMINDER_HINTS[key]}>
        <Switch checked={draft.reminders[key]} label={label} disabled={locked}
                onChange={(on) => setReminder(key, on)} />
      </Setting>
    );
  };

  // at five days the picker offers no more (the API's limit)
  const picked = draft.reminders.offsets_days;
  const full = picked.length >= MAX_OFFSETS;
  const offsetOptions = full ? OFFSET_OPTIONS.filter((o) => picked.includes(o.value)) : OFFSET_OPTIONS;

  return (
    <form className="pln-sys" ref={formRef} noValidate onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <Card id="pps-scheduling" title="Scheduling"
            hint={<p>How plans schedule unless they set their own. A change reschedules the plans that use it.</p>}>
        <div className="pf-form pln-sys-body">
          <Setting id="pps-honor" label="Honor constraints" hint="A constraint wins over a link that disagrees with it.">
            <Switch checked={draft.honorConstraints} label="Honor constraints" disabled={locked}
                    onChange={(on) => set({ honorConstraints: on })} />
          </Setting>
          <Setting id="pps-slack" label="Critical slack (days)" error={errors.criticalSlackDays}
                   hint="Tasks with this much slack or less are critical. Fractions of a day are fine.">
            <input type="number" className="pln-sys-input" min={0} max={30} step="any"
                   aria-labelledby="pps-slack-label" aria-describedby="pps-slack-hint"
                   aria-invalid={!!errors.criticalSlackDays} value={draft.criticalSlackDays} disabled={locked}
                   onChange={(e) => set({ criticalSlackDays: e.target.value })} />
          </Setting>
          <Setting id="pps-mode" label="Default task mode" hint="How a new task is scheduled.">
            <Choice label="Default task mode" options={choiceOptions(TASK_MODES)} value={draft.defaultTaskMode}
                    disabled={locked} onChange={(v) => set({ defaultTaskMode: v })} />
          </Setting>
          <Setting id="pps-duration" label="Default duration" error={errors.defaultDuration}
                   hint="A new task’s duration, like 1d or 4h, in the plan calendar’s hours.">
            <input type="text" className="pln-sys-input" autoComplete="off" spellCheck={false}
                   aria-labelledby="pps-duration-label" aria-describedby="pps-duration-hint"
                   aria-invalid={!!errors.defaultDuration} value={draft.defaultDuration} disabled={locked}
                   onChange={(e) => set({ defaultDuration: e.target.value })} />
          </Setting>
          <Setting id="pps-times" label="Show times" hint="Dates in the sheet carry their time of day.">
            <Switch checked={draft.showTimes} label="Show times" disabled={locked}
                    onChange={(on) => set({ showTimes: on })} />
          </Setting>
        </div>
      </Card>

      <Card id="pps-calendar" title="Default calendar" hint={<p className="page-hint">{CALENDAR_HINT}</p>}>
        <div className="pln-sys-pad pln-sys-cal">
          <CalendarEditor value={draft.calendar} errors={errors} disabled={locked}
                          onChange={(calendar) => set({ calendar })} />
        </div>
      </Card>

      <Card id="pps-completion" title="Completion rules" hint={<p>What marking a task complete checks first.</p>}>
        <div className="pf-form pln-sys-body">
          <Setting id="pps-subtasks" label={SETTING_LABELS['completion.subtasks']} hint={COMPLETION_HINTS.subtasks}>
            <Choice label={SETTING_LABELS['completion.subtasks']} options={choiceOptions(SUBTASK_RULES)}
                    value={draft.completion.subtasks} disabled={locked}
                    onChange={(v) => set({ completion: { ...draft.completion, subtasks: v } })} />
          </Setting>
          <Setting id="pps-predecessors" label={SETTING_LABELS['completion.predecessors']}
                   hint={COMPLETION_HINTS.predecessors}>
            <Choice label={SETTING_LABELS['completion.predecessors']} options={choiceOptions(PREDECESSOR_RULES)}
                    value={draft.completion.predecessors} disabled={locked}
                    onChange={(v) => set({ completion: { ...draft.completion, predecessors: v } })} />
          </Setting>
        </div>
      </Card>

      <Card id="pps-reminders" title="Reminders"
            hint={<p>Due-date reminders and notices to the people assigned to a task.</p>}>
        {/* a .pf-form: the native time field's house (global constraint) */}
        <div className="pf-form pln-sys-body">
          {reminderSwitch('enabled')}
          <Setting id="pps-offsets" label={SETTING_LABELS['reminders.offsets_days']}
                   hint={`Up to ${MAX_OFFSETS} days before a task is due.`} error={errors['reminders.offsets_days']}>
            <div className="pln-sys-picker" role="group" aria-labelledby="pps-offsets-label">
              <ChipPicker options={offsetOptions} selected={picked} disabled={locked}
                          invalid={!!errors['reminders.offsets_days']}
                          onChange={(v) => setReminder('offsets_days', offsetDays(v).map(String))}
                          ariaLabel="Add a reminder day" placeholder="Add a day…"
                          note={full ? `${MAX_OFFSETS} days is the most.` : undefined} />
            </div>
          </Setting>
          {reminderSwitch('on_due_day')}
          <Setting id="pps-overdue" label={SETTING_LABELS['reminders.overdue']} hint={REMINDER_HINTS.overdue}>
            <Choice label={SETTING_LABELS['reminders.overdue']} options={choiceOptions(OVERDUE_CADENCES)}
                    value={draft.reminders.overdue} disabled={locked}
                    onChange={(v) => setReminder('overdue', v)} />
          </Setting>
          <Setting id="pps-send" label={SETTING_LABELS['reminders.send_time']} hint={REMINDER_HINTS.send_time}
                   error={errors['reminders.send_time']}>
            <input type="time" className="pln-sys-input" aria-labelledby="pps-send-label"
                   aria-describedby="pps-send-hint" aria-invalid={!!errors['reminders.send_time']}
                   value={draft.reminders.send_time} disabled={locked}
                   onChange={(e) => setReminder('send_time', e.target.value)} />
          </Setting>
          {reminderSwitch('use_finish_without_deadline')}
          {reminderSwitch('notify_on_assign')}
          {reminderSwitch('overdue_to_owner')}
          {reminderSwitch('email_assignees')}
        </div>
      </Card>

      {canChange && (
        <div className="pln-sys-actions">
          <button type="submit" className="btn-solid" disabled={!dirty || !valid || saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          {dirty && (
            <button type="button" className="mini-btn" disabled={saving} onClick={discard}>Discard</button>
          )}
          {dirty && fix && (
            <p className="page-hint pln-sys-fix">
              {fix}{' '}
              <button type="button" className="link-plain" onClick={jumpToError}>Go to it</button>
            </p>
          )}
          {error && <span className="pf-error" role="alert">{error}</span>}
        </div>
      )}
    </form>
  );
}
