/**
 * New project plan: the project start date and a template, then
 * `ctl.create`. The plan's own zone is unknown until it exists, so the
 * date defaults to the browser's today; a date alone starts at the
 * calendar's default start time (the API applies it). The API makes the
 * creator the owner (changed later in Plan settings).
 *
 * The template picker (a ComboBox of GET /plan-templates, each with its
 * task count and description) is required when the dialog opens from
 * "From a template" (Create stays off until the list is in, and a failed
 * load says “Couldn’t load templates.” beside Try again) and optional
 * from "Blank plan", where a list that can't be loaded never stands in
 * the way. From a template the plan
 * gets the template's tasks, links, settings and working week and hours,
 * every date moved to the project start, and the system calendar's
 * holidays; without one it is empty, on the system calendar.
 * The picker is not the first field: focusing a ComboBox opens its list,
 * so the project start keeps the first focus.
 *
 * A 409 `plan_exists` (someone else made one meanwhile) closes on their
 * plan, which usePlan has already loaded, and says so; a template deleted
 * meanwhile (404 `template_not_found`) says so and reloads the list; any
 * other refusal stays open with the reason.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { longDateOf } from '../../lib/format';
import { useToast } from '../../lib/notificationsContext';
import { listPlanTemplates, type PlanTemplate } from '../../lib/plans/api';
import { TEMPLATES_UNLOADED, planErrorDetail, planErrorText, isPlanChanged } from '../../lib/plans/errors';
import { fromDateInput } from '../../lib/plans/floatingTime';
import ComboBox, { type ComboOption } from '../ComboBox';
import PlanModal from './PlanModal';
import type { PlanController } from './usePlan';

export interface PlanInitiative {
  name: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
}

const FORM_ID = 'pln-create-form';
export const CHOOSE_TEMPLATE = 'Choose a template.';
const BLANK_DESCRIPTION = 'An empty schedule on the system working calendar. Add tasks once it’s created.';
const TEMPLATE_DESCRIPTION = 'The template’s tasks, links, settings and working week and hours, every date moved '
  + 'to the project start. Holidays come from the system calendar.';

const pad = (n: number) => String(n).padStart(2, '0');

/** The browser's own calendar day as `YYYY-MM-DD`. Local getters on purpose:
 *  this is "today where the planner sits", not a plan time. */
function browserToday(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** An initiative's date-only field (`YYYY-MM-DD`, or midnight UTC) as
 *  "Nov 14, 2026", read from its digits so no zone shifts the day. */
function initiativeDay(value: string | null): string | null {
  const m = value ? /^(\d{4})-(\d{2})-(\d{2})/.exec(value) : null;
  return m ? longDateOf(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
}

/** "The initiative is scheduled Nov 14, 2026 – Nov 16, 2026." or null. */
function scheduledText(initiative: PlanInitiative): string | null {
  const start = initiativeDay(initiative.scheduled_start);
  const end = initiativeDay(initiative.scheduled_end);
  if (start && end) return `The initiative is scheduled ${start} – ${end}.`;
  if (start) return `The initiative is scheduled to start ${start}.`;
  if (end) return `The initiative is scheduled to end ${end}.`;
  return null;
}

/** A template as a picker option: its name, then "12 tasks · description". */
function optionOf(t: PlanTemplate): ComboOption {
  const tasks = t.task_count === 1 ? '1 task' : `${t.task_count.toLocaleString('en-US')} tasks`;
  return { value: t.id, label: t.name, sub: t.description ? `${tasks} · ${t.description}` : tasks };
}

type Templates = { state: 'loading' } | { state: 'error' } | { state: 'ready'; list: PlanTemplate[] };

export default function PlanCreateModal({ ctl, initiative, fromTemplate = false, onClose }: {
  ctl: PlanController;
  initiative: PlanInitiative;
  /** Opened from "From a template": a template is required. */
  fromTemplate?: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const [start, setStart] = useState(() => browserToday());
  const [templateId, setTemplateId] = useState('');
  const [templates, setTemplates] = useState<Templates>({ state: 'loading' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const scheduled = scheduledText(initiative);
  const alive = useRef(true);
  // set on every mount: StrictMode's dev remount runs the cleanup first
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const loadTemplates = useCallback(async () => {
    setTemplates({ state: 'loading' });
    try {
      const list = await listPlanTemplates();
      if (alive.current) setTemplates({ state: 'ready', list });
    } catch {
      if (alive.current) setTemplates({ state: 'error' });
    }
  }, []);
  useEffect(() => { void loadTemplates(); }, [loadTemplates]);

  const list = templates.state === 'ready' ? templates.list : [];
  const none = templates.state === 'ready' && list.length === 0;
  const create = async () => {
    const day = fromDateInput(start);
    if (!day) {
      setError('Pick the project start date.');
      return;
    }
    if (fromTemplate && !templateId) {
      setError(CHOOSE_TEMPLATE);
      return;
    }
    setSaving(true);
    setError('');
    try {
      await ctl.create(templateId ? { project_start: day, template_id: templateId } : { project_start: day });
      onClose();
    } catch (err) {
      if (isPlanChanged(err)) {
        onClose();
        return;
      }
      const code = planErrorDetail(err)?.code;
      if (code === 'plan_exists') {
        toast(planErrorText(err));
        onClose();
        return;
      }
      setError(planErrorText(err));
      setSaving(false);
      if (code === 'template_not_found') {
        setTemplateId('');
        void loadTemplates();
      }
    }
  };

  const useTemplate = fromTemplate || templateId !== '';
  const placeholder = templates.state === 'loading' ? 'Loading templates…'
    : templates.state === 'error' ? 'Templates couldn’t be loaded'
      : none ? 'No templates saved yet'
        : fromTemplate ? 'Choose a template' : 'None: a blank plan';
  const picker = (
    <div className="full">
      <label htmlFor="pln-create-template">Template</label>
      <ComboBox inputId="pln-create-template" ariaLabel="Template" options={list.map(optionOf)} value={templateId}
                placeholder={placeholder} clearable={!fromTemplate}
                disabled={saving || templates.state !== 'ready' || none}
                invalid={error === CHOOSE_TEMPLATE}
                onChange={(value) => {
                  setTemplateId(value);
                  if (error === CHOOSE_TEMPLATE) setError('');
                }} />
    </div>
  );

  return (
    <PlanModal title={fromTemplate ? 'New plan from a template' : 'New project plan'}
               description={useTemplate ? TEMPLATE_DESCRIPTION : BLANK_DESCRIPTION}
               onClose={onClose} busy={saving}
               footer={(
                 <>
                   <button type="submit" form={FORM_ID} className="btn-solid"
                           disabled={saving || (fromTemplate && (templates.state !== 'ready' || none))}>
                     {saving ? 'Creating…' : 'Create plan'}
                   </button>
                   <button type="button" className="mini-btn" onClick={onClose} disabled={saving}>Cancel</button>
                   {error && <span className="pf-error" role="alert">{error}</span>}
                 </>
               )}>
      <form id={FORM_ID} className="pf-form pln-create-form"
            onSubmit={(e) => { e.preventDefault(); if (!saving) void create(); }}>
        {fromTemplate && picker}
        <div>
          <label htmlFor="pln-create-start">Project start</label>
          <input id="pln-create-start" type="date" value={start} disabled={saving}
                 onChange={(e) => setStart(e.target.value)} />
        </div>
        {!fromTemplate && picker}
        {fromTemplate && none && (
          <p className="full pln-note">
            No templates yet. Make one with Save as template… in a plan’s More menu.
          </p>
        )}
        {fromTemplate && templates.state === 'error' && (
          <div className="full pln-load-problem">
            <p className="pf-error" role="alert">{TEMPLATES_UNLOADED}</p>
            <button type="button" className="mini-btn" onClick={() => void loadTemplates()}>Try again</button>
          </div>
        )}
        {scheduled && <p className="full pln-note">{scheduled}</p>}
      </form>
    </PlanModal>
  );
}
