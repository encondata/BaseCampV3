/**
 * Task Information › General: Task Name, Duration, % Complete, Start,
 * Finish, the task mode, Deadline (due date), Color (the task color
 * popover), Milestone and Display on Timeline. A summary's Duration, Start
 * and Finish come from its subtasks: shown read-only, with a note saying so.
 */
import { useState } from 'react';

import { colorLabel } from '../../../lib/plans/taskColor';
import { Switch } from '../../Switch';
import TaskColorPicker from '../TaskColorPicker';
import { errorId, dateType, type PanelProps } from './panel';

function FieldError({ field, errors }: { field: string; errors: PanelProps['errors'] }) {
  const text = errors[field];
  return text ? <p id={errorId(field)} className="pf-error pln-ti-error" role="alert">{text}</p> : null;
}

export default function GeneralPanel({ plan, task, form, set, errors, can }: PanelProps) {
  const type = dateType(plan);
  const [colorButton, setColorButton] = useState<HTMLButtonElement | null>(null);
  const [picking, setPicking] = useState(false);
  const donePicking = () => {
    setPicking(false);
    colorButton?.focus();
  };
  const derived = task.is_summary;
  const invalid = (field: string) => (errors[field]
    ? { 'aria-invalid': true as const, 'aria-describedby': errorId(field) } : {});
  // a summary's derived fields read as values; anything else off is disabled
  const lock = (field: 'duration' | 'start' | 'finish') => (derived
    ? { readOnly: true, 'aria-readonly': true as const }
    : { disabled: !can(field) });

  return (
    <div className="pf-form pln-ti-form">
      <div className="full">
        <label htmlFor="pln-ti-name">Task Name</label>
        <input id="pln-ti-name" type="text" value={form.name} disabled={!can('name')} autoComplete="off"
               spellCheck={false} onChange={(e) => set({ name: e.target.value })} {...invalid('name')} />
        <FieldError field="name" errors={errors} />
      </div>
      {derived && <p className="full pln-note">Duration, Start and Finish come from its subtasks.</p>}
      <div>
        <label htmlFor="pln-ti-duration">Duration</label>
        <input id="pln-ti-duration" type="text" value={form.duration} autoComplete="off" spellCheck={false}
               placeholder="5d, 4h, 3ed" onChange={(e) => set({ duration: e.target.value })}
               {...lock('duration')} {...invalid('duration')} />
        <FieldError field="duration" errors={errors} />
      </div>
      <div>
        <label htmlFor="pln-ti-percent">% Complete</label>
        <input id="pln-ti-percent" type="number" min={0} max={100} step={1} inputMode="numeric" value={form.percent}
               disabled={!can('percent')} onChange={(e) => set({ percent: e.target.value })} {...invalid('percent')} />
        <FieldError field="percent" errors={errors} />
      </div>
      <div>
        <label htmlFor="pln-ti-start">Start</label>
        <input id="pln-ti-start" type={type} value={form.start} onChange={(e) => set({ start: e.target.value })}
               {...lock('start')} {...invalid('start')} />
        <FieldError field="start" errors={errors} />
      </div>
      <div>
        <label htmlFor="pln-ti-finish">Finish</label>
        <input id="pln-ti-finish" type={type} value={form.finish} onChange={(e) => set({ finish: e.target.value })}
               {...lock('finish')} {...invalid('finish')} />
        <FieldError field="finish" errors={errors} />
      </div>
      <div>
        <span className="pln-ti-label" id="pln-ti-mode-label">Task Mode</span>
        <div className="segmented pln-ti-mode" role="group" aria-labelledby="pln-ti-mode-label">
          {(['auto', 'manual'] as const).map((m) => (
            <button key={m} type="button" aria-pressed={form.mode === m} className={form.mode === m ? 'on' : ''}
                    disabled={!can('mode')} onClick={() => set({ mode: m })}>
              {m === 'auto' ? 'Auto Scheduled' : 'Manually Scheduled'}
            </button>
          ))}
        </div>
      </div>
      <div>
        <label htmlFor="pln-ti-deadline">Deadline (due date)</label>
        <input id="pln-ti-deadline" type={type} value={form.deadline} disabled={!can('deadline')}
               onChange={(e) => set({ deadline: e.target.value })} {...invalid('deadline')} />
        <FieldError field="deadline" errors={errors} />
      </div>
      <div>
        <label htmlFor="pln-ti-color">Color</label>
        <button ref={setColorButton} id="pln-ti-color" type="button" className="org-select pln-ti-color"
                disabled={!can('color')} aria-haspopup="dialog" aria-expanded={picking}
                onClick={() => setPicking((on) => !on)}>
          {form.color && <span className="color-swatch" style={{ background: form.color }} aria-hidden="true" />}
          {form.color ? colorLabel(form.color) : 'No color'}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"
               strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
        </button>
        {picking && colorButton && (
          <TaskColorPicker anchor={colorButton} value={form.color}
                           onPick={(color) => {
                             set({ color });
                             donePicking();
                           }}
                           onClose={donePicking} />
        )}
      </div>
      <div className="full pln-switch-line">
        <span className="pln-switch-text">
          <b>Milestone</b>
          <span>Shown as a diamond on the chart.</span>
        </span>
        <Switch checked={form.milestone} label="Milestone" disabled={!can('milestone')}
                onChange={(on) => set({ milestone: on })} />
      </div>
      <div className="full pln-switch-line">
        <span className="pln-switch-text">
          <b>Display on Timeline</b>
          <span>Listed on the plan’s timeline strip.</span>
        </span>
        <Switch checked={form.timeline} label="Display on Timeline" disabled={!can('timeline')}
                onChange={(on) => set({ timeline: on })} />
      </div>
    </div>
  );
}

export { FieldError };
