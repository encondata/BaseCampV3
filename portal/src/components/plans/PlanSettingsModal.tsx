/**
 * Plan settings (More › Plan settings…), in four `.segmented` sections
 * (spec Settings, Dialogs):
 *  - General: project start, owner (staff only: `is_staff`), timezone
 *    (every IANA zone), status date (blank = now), default task mode,
 *    default duration, critical slack in days (fractions allowed), Show
 *    times, Honor constraints.
 *  - Calendar: CalendarEditor.
 *  - Completion rules and Reminders: each key with "Use system default
 *    (<value>)" — the system value the plan inherits (`system_settings`);
 *    turning it off shows the control, turning it back on sends null.
 *
 * The form is lib/plans/settingsForm's: Save checks it (a failure shows by
 * its field and goes to its section), then PATCHes only what changed
 * through ctl.patch; nothing changed closes. A locked plan takes only the
 * status date and the owner: the rest shows, off, saying why. Someone
 * else's change (409 plan_changed) closes it quietly (usePlan reloaded and
 * said so); any other refusal stays in the dialog with its reason. It holds
 * editing while open.
 */
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';

import type { CompletionSettings, ReminderSettings } from '../../lib/plans/api';
import { SETTING_LABELS, isPlanChanged, planErrorText } from '../../lib/plans/errors';
import { naturalCompare } from '../../lib/naturalSort';
import { timezoneOptions } from '../../lib/notifications';
import {
  COMPLETION_HINTS, OVERDUE_CADENCES, PREDECESSOR_RULES, REMINDER_HINTS, REMINDER_KEYS, SETTINGS_SECTIONS,
  SUBTASK_RULES, TASK_MODES, sectionOfError, systemValueText, toForm, toPatch, validate, type Inherit,
  type SettingsErrors, type SettingsForm, type SettingsSection,
} from '../../lib/plans/settingsForm';
import ComboBox, { type ComboOption } from '../ComboBox';
import { Switch } from '../Switch';
import CalendarEditor from './CalendarEditor';
import PlanModal from './PlanModal';
import { Choice, OnOff, choiceOptions } from './SettingChoice';
import type { PlanController } from './usePlan';

import '../../styles/profile.css';   // .pf-form, .btn-solid

const HOLD_OWNER = 'plan-settings';
const FORM_ID = 'pln-settings-form';
export const LOCKED_NOTE = 'Schedule is locked: only the status date and the owner can change until it’s unlocked.';

/** One inheritable key: its name, "Use system default (<value>)", and its control while that is off. */
function InheritField({ label, hint, system, inherit, disabled, error, onInherit, children }: {
  label: string;
  hint?: string;
  system: string;
  inherit: boolean;
  disabled: boolean;
  error?: string;
  onInherit(on: boolean): void;
  children: ReactNode;
}) {
  return (
    <div className="pln-set-item">
      <div className="pln-switch-text">
        <b>{label}</b>
        {hint && <span>{hint}</span>}
      </div>
      <div className="pln-set-inherit">
        <Switch checked={inherit} label={`${label}: use system default (${system})`} disabled={disabled}
                onChange={onInherit} />
        <span aria-hidden="true">Use system default ({system})</span>
      </div>
      {!inherit && <div className="pln-set-control">{children}</div>}
      {error && <p className="pf-error pln-set-error" role="alert">{error}</p>}
    </div>
  );
}

function FieldError({ text }: { text: string | undefined }) {
  return text ? <p className="pf-error pln-set-error" role="alert">{text}</p> : null;
}

export default function PlanSettingsModal({ ctl, onClose }: { ctl: PlanController; onClose(): void }) {
  const plan = ctl.plan;
  const [form, setForm] = useState<SettingsForm | null>(() => (plan ? toForm(plan) : null));
  const [section, setSection] = useState<SettingsSection>('general');
  const [errors, setErrors] = useState<SettingsErrors>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const { beginEditing } = ctl;
  useEffect(() => beginEditing(HOLD_OWNER), [beginEditing]);
  useEffect(() => {
    if (!plan && !busy) onClose();
  }, [plan, busy, onClose]);

  const zones = useMemo(() => timezoneOptions(), []);
  const owners = useMemo((): ComboOption[] => {
    const staff = (plan?.resources ?? []).filter((r) => r.kind === 'person' && r.is_staff)
      .map((r) => ({ value: r.id, label: r.name }))
      .sort((a, b) => naturalCompare(a.label, b.label));
    // an owner who is no longer staff still shows by name
    if (plan?.owner_id && !staff.some((o) => o.value === plan.owner_id)) {
      staff.unshift({ value: plan.owner_id, label: plan.owner_name ?? 'Current owner' });
    }
    return staff;
  }, [plan]);
  if (!plan || !form) return null;

  const locked = plan.locked_at !== null;
  const off = busy || locked;                     // what a locked plan doesn't take
  const set = (patch: Partial<SettingsForm>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    setError('');
  };
  const dateType = plan.settings.show_times ? 'datetime-local' : 'date';

  const setCompletion = <K extends keyof CompletionSettings>(key: K, next: Inherit<CompletionSettings[K]>) =>
    set({ completion: { ...form.completion, [key]: next } });
  const setReminder = <K extends keyof SettingsForm['reminders']>(key: K, next: SettingsForm['reminders'][K]) =>
    set({ reminders: { ...form.reminders, [key]: next } });

  const save = async () => {
    const found = validate(form);
    setErrors(found);
    const first = Object.keys(found)[0];
    if (first) {
      setSection(sectionOfError(first));
      return;
    }
    const { base_version: _version, ...fields } = toPatch(form, plan);
    if (!Object.keys(fields).length) {
      onClose();
      return;
    }
    setBusy(true);
    setError('');
    try {
      await ctl.patch(fields);
      onClose();
    } catch (err) {
      if (isPlanChanged(err)) {
        onClose();
        return;
      }
      setError(planErrorText(err));
      setBusy(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!busy) void save();
  };

  const reminderControl = (key: keyof ReminderSettings): ReactNode => {
    const label = SETTING_LABELS[`reminders.${key}`];
    switch (key) {
      case 'offsets_days': {
        const field = form.reminders.offsets_days;
        return (
          <input type="text" className="pln-set-short" aria-label={label} value={field.value} disabled={off}
                 placeholder="3, 1" onChange={(e) => setReminder('offsets_days', { ...field, value: e.target.value })} />
        );
      }
      case 'send_time': {
        const field = form.reminders.send_time;
        return (
          <input type="time" className="pln-set-short" aria-label={label} value={field.value} disabled={off}
                 onChange={(e) => setReminder('send_time', { ...field, value: e.target.value })} />
        );
      }
      case 'overdue': {
        const field = form.reminders.overdue;
        return (
          <Choice label={label} value={field.value} disabled={off} options={choiceOptions(OVERDUE_CADENCES)}
                  onChange={(v) => setReminder('overdue', { ...field, value: v })} />
        );
      }
      default: {
        const field = form.reminders[key] as Inherit<boolean>;
        return <OnOff label={label} value={field.value} disabled={off}
                      onChange={(v) => setReminder(key, { ...field, value: v } as never)} />;
      }
    }
  };

  return (
    <PlanModal title="Plan settings" size="xwide" busy={busy} onClose={onClose}
               description="How this plan schedules, its working calendar, and the checks and reminders it runs."
               footer={(
                 <>
                   <button type="submit" form={FORM_ID} className="btn-solid" disabled={busy}>
                     {busy ? 'Saving…' : 'Save'}
                   </button>
                   <button type="button" className="mini-btn" disabled={busy} onClick={onClose}>Cancel</button>
                   {error && <span className="pf-error" role="alert">{error}</span>}
                 </>
               )}>
      <div className="pln-set">
        <div className="segmented pln-set-tabs" role="group" aria-label="Plan settings sections">
          {SETTINGS_SECTIONS.map((s) => (
            <button key={s.key} type="button" aria-pressed={section === s.key} className={section === s.key ? 'on' : ''}
                    onClick={() => setSection(s.key)}>
              {s.label}
            </button>
          ))}
        </div>
        {locked && <p className="pln-note pln-locked-note">{LOCKED_NOTE}</p>}

        <form id={FORM_ID} className="pln-set-body" onSubmit={onSubmit} noValidate>
          <div hidden={section !== 'general'}>
            <div className="pf-form pln-set-general">
              <div>
                <label htmlFor="pln-set-start">Project start</label>
                <input id="pln-set-start" type={dateType} value={form.projectStart} disabled={off}
                       onChange={(e) => set({ projectStart: e.target.value })} />
                <FieldError text={errors.projectStart} />
              </div>
              <div>
                <label htmlFor="pln-set-owner">Owner</label>
                <ComboBox inputId="pln-set-owner" ariaLabel="Owner" options={owners} value={form.ownerId} clearable
                          placeholder="No owner" disabled={busy} onChange={(v) => set({ ownerId: v })} />
              </div>
              <div>
                <label htmlFor="pln-set-zone">Timezone</label>
                <ComboBox inputId="pln-set-zone" ariaLabel="Timezone" options={zones} value={form.timezone}
                          disabled={off} onChange={(v) => set({ timezone: v })} />
                <FieldError text={errors.timezone} />
              </div>
              <div>
                <label htmlFor="pln-set-status">Status date</label>
                <input id="pln-set-status" type={dateType} value={form.statusDate} disabled={busy}
                       onChange={(e) => set({ statusDate: e.target.value })} />
                <p className="pln-note pln-set-hint">Blank: the status date is always now.</p>
                <FieldError text={errors.statusDate} />
              </div>
              <div>
                <span className="pln-set-label" id="pln-set-mode-label">Default task mode</span>
                <Choice label="Default task mode" value={form.defaultTaskMode} disabled={off}
                        options={choiceOptions(TASK_MODES)} onChange={(v) => set({ defaultTaskMode: v })} />
              </div>
              <div>
                <label htmlFor="pln-set-duration">Default duration</label>
                <input id="pln-set-duration" type="text" value={form.defaultDuration} disabled={off} autoComplete="off"
                       spellCheck={false} onChange={(e) => set({ defaultDuration: e.target.value })} />
                <FieldError text={errors.defaultDuration} />
              </div>
              <div>
                <label htmlFor="pln-set-slack">Critical slack (days)</label>
                <input id="pln-set-slack" type="number" min={0} max={30} step="any" value={form.criticalSlackDays}
                       disabled={off} onChange={(e) => set({ criticalSlackDays: e.target.value })} />
                <p className="pln-note pln-set-hint">Tasks with this much slack or less are critical.</p>
                <FieldError text={errors.criticalSlackDays} />
              </div>
              <div />
              <div className="full pln-switch-line">
                <span className="pln-switch-text">
                  <b>Show times</b>
                  <span>Dates in the sheet carry their time of day.</span>
                </span>
                <Switch checked={form.showTimes} label="Show times" disabled={off}
                        onChange={(on) => set({ showTimes: on })} />
              </div>
              <div className="full pln-switch-line">
                <span className="pln-switch-text">
                  <b>Honor constraints</b>
                  <span>A constraint wins over a link that disagrees with it.</span>
                </span>
                <Switch checked={form.honorConstraints} label="Honor constraints" disabled={off}
                        onChange={(on) => set({ honorConstraints: on })} />
              </div>
            </div>
          </div>

          <div hidden={section !== 'calendar'}>
            <CalendarEditor value={form.calendar} errors={errors} disabled={off}
                            onChange={(calendar) => set({ calendar })} />
          </div>

          <div hidden={section !== 'completion'}>
            <div className="pln-set-items">
              <InheritField label={SETTING_LABELS['completion.subtasks']} hint={COMPLETION_HINTS.subtasks}
                            system={systemValueText('completion', 'subtasks', plan.system_settings.completion.subtasks)}
                            inherit={form.completion.subtasks.inherit} disabled={off}
                            onInherit={(on) => setCompletion('subtasks', { ...form.completion.subtasks, inherit: on })}>
                <Choice label={SETTING_LABELS['completion.subtasks']} value={form.completion.subtasks.value} disabled={off}
                        options={choiceOptions(SUBTASK_RULES)}
                        onChange={(v) => setCompletion('subtasks', { inherit: false, value: v })} />
              </InheritField>
              <InheritField label={SETTING_LABELS['completion.predecessors']}
                            hint={COMPLETION_HINTS.predecessors}
                            system={systemValueText('completion', 'predecessors',
                              plan.system_settings.completion.predecessors)}
                            inherit={form.completion.predecessors.inherit} disabled={off}
                            onInherit={(on) => setCompletion('predecessors', { ...form.completion.predecessors, inherit: on })}>
                <Choice label={SETTING_LABELS['completion.predecessors']} value={form.completion.predecessors.value}
                        disabled={off}
                        options={choiceOptions(PREDECESSOR_RULES)}
                        onChange={(v) => setCompletion('predecessors', { inherit: false, value: v })} />
              </InheritField>
            </div>
          </div>

          <div hidden={section !== 'reminders'}>
            {/* a .pf-form: the native time field's house (global constraint) */}
            <div className="pf-form pln-set-items">
              {REMINDER_KEYS.map((key) => {
                const field = form.reminders[key];
                return (
                  <InheritField key={key} label={SETTING_LABELS[`reminders.${key}`]} hint={REMINDER_HINTS[key]}
                                system={systemValueText('reminders', key, plan.system_settings.reminders[key])}
                                inherit={field.inherit} disabled={off} error={errors[`reminders.${key}`]}
                                onInherit={(on) => setReminder(key, { ...field, inherit: on } as never)}>
                    {reminderControl(key)}
                  </InheritField>
                );
              })}
            </div>
          </div>
        </form>
      </div>
    </PlanModal>
  );
}
