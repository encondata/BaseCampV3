/**
 * Save as template (More › Save as template…, `project_plans:add`): a name
 * and a description, then POST /plans/{id}/save-as-template. The API keeps
 * the plan's structure (tasks, durations, links, constraints, deadlines,
 * notes, colors, the working week and hours and the settings overrides)
 * with every date as an offset from the project start; never the
 * calendar's holidays, resources, progress or the baseline. Every plan
 * viewer sees templates, so the dialog says notes go along. The plan itself doesn't change, so this writes outside the
 * PlanController.
 *
 * The name is required (the API trims it and allows 120 characters, the
 * house rule for a saved item's name); a taken name (409
 * `template_exists`, ignoring case) stays in the dialog with the reason.
 */
import { useState, type FormEvent } from 'react';

import { useToast } from '../../lib/notificationsContext';
import { saveAsTemplate } from '../../lib/plans/api';
import { planErrorDetail, planErrorText } from '../../lib/plans/errors';
import PlanModal from './PlanModal';

import '../../styles/profile.css';   // .pf-form, .btn-solid

const FORM_ID = 'pln-save-template-form';
export const MAX_TEMPLATE_NAME = 120;
export const MAX_TEMPLATE_DESCRIPTION = 1000;
export const NAME_REQUIRED = 'Enter a name for the template.';

/** A refusal about one of the template's own fields, in words (the plan
 *  errors' `bad_field` names task fields: "name" there is Task Name). */
export function templateErrorText(err: unknown): string {
  const detail = planErrorDetail(err);
  if (detail?.code === 'bad_field' && detail.field === 'name') {
    return `${NAME_REQUIRED.slice(0, -1)}, up to ${MAX_TEMPLATE_NAME} characters.`;
  }
  if (detail?.code === 'bad_field' && detail.field === 'description') {
    return `Keep the description to ${MAX_TEMPLATE_DESCRIPTION.toLocaleString('en-US')} characters.`;
  }
  return planErrorText(err);
}

/** What the template keeps: "Keep this plan’s 12 tasks (durations, links
 *  and notes included) and its working week and hours to start new plans
 *  from." Notes are named: templates are shared with every plan viewer. */
export function keepsText(count: number): string {
  if (count === 0) return 'Keep this plan’s settings and its working week and hours to start new plans from.';
  const tasks = count === 1 ? '1 task (its duration, links and notes included)'
    : `${count.toLocaleString('en-US')} tasks (durations, links and notes included)`;
  return `Keep this plan’s ${tasks} and its working week and hours to start new plans from.`;
}

export const SHARED_NOTE = 'Everyone who can view project plans can see and use templates, task notes included.';

export default function SaveTemplateModal({ planId, taskCount, onClose }: {
  planId: string;
  taskCount: number;
  onClose(): void;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(NAME_REQUIRED);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await saveAsTemplate(planId, { name: trimmed, description: description.trim() || null });
    } catch (err) {
      setError(templateErrorText(err));
      setBusy(false);
      return;
    }
    toast(`Template “${trimmed}” saved.`);
    onClose();
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!busy) void save();
  };

  return (
    <PlanModal title="Save as template" busy={busy} onClose={onClose}
               description={`${keepsText(taskCount)} Resources, progress and the baseline aren’t saved.`}
               footer={(
                 <>
                   <button type="submit" form={FORM_ID} className="btn-solid" disabled={busy}>
                     {busy ? 'Saving…' : 'Save template'}
                   </button>
                   <button type="button" className="mini-btn" disabled={busy} onClick={onClose}>Cancel</button>
                   {error && <span className="pf-error" role="alert">{error}</span>}
                 </>
               )}>
      <form id={FORM_ID} className="pf-form pln-template-form" onSubmit={onSubmit}>
        <div className="full">
          <label htmlFor="pln-save-template-name">Name</label>
          <input id="pln-save-template-name" type="text" value={name} maxLength={MAX_TEMPLATE_NAME}
                 autoComplete="off" disabled={busy} aria-invalid={error === NAME_REQUIRED ? true : undefined}
                 onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="full">
          <label htmlFor="pln-save-template-description">Description</label>
          <textarea id="pln-save-template-description" className="pln-text-field" rows={3} value={description}
                    maxLength={MAX_TEMPLATE_DESCRIPTION} disabled={busy}
                    onChange={(e) => setDescription(e.target.value)} />
        </div>
        <p className="full pln-note">{SHARED_NOTE}</p>
      </form>
    </PlanModal>
  );
}
