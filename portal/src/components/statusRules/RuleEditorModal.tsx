/**
 * RuleEditorModal — schema-driven create/edit builder for status rules.
 * Everything the form can offer (trigger statuses, match types,
 * operators, condition fields, actions + their params) comes from the
 * `schema` prop (Task 9's /status-rules/schema payload) — nothing is
 * fetched here, so the modal can never drift from the engine's
 * vocabulary. `rule === null` creates via createStatusRule; otherwise
 * saves via updateStatusRule(rule.id, …).
 *
 * Follows the modal-scrim/modal-card/modal-head/modal-body/modal-foot
 * skeleton from pages/Notifications.tsx's NewGroupModal (lines
 * 352-397), with .modal-section dividers as in SiteEditModal.
 *
 * `enabled` is deliberately not editable here — that's the list's
 * toggle switch (RulesTab); the editor only carries it through on save
 * (defaulting to true for a new rule).
 */

import { useState, type FormEvent } from 'react';

import {
  ApiError, createStatusRule, updateStatusRule,
  type RuleSchemaAction, type RuleSchemaParam, type SchemaOption,
  type StatusRule, type StatusRuleAction, type StatusRuleCondition,
  type StatusRuleIn, type StatusRuleSchema,
} from '../../lib/api';

interface Props {
  schema: StatusRuleSchema;
  rule: StatusRule | null; // null = create mode
  onClose: () => void;
  onSaved: () => void;
}

const DEFAULT_PRIORITY = 10;

const ERRORS: Record<string, string> = {
  bad_trigger: 'Pick a valid trigger status and match type.',
  bad_condition: 'One of the conditions is invalid.',
  bad_action: 'One of the actions is invalid.',
  rule_not_found: 'This rule no longer exists — it may have been deleted.',
};

const msgFor = (err: unknown): string =>
  err instanceof ApiError
    ? (ERRORS[err.code] ?? `Request failed (${err.code}).`)
    : 'Network error — nothing was saved.';

function optionValue(o: string | SchemaOption): string {
  return typeof o === 'string' ? o : o.value;
}
function optText(o: string | SchemaOption): string {
  return typeof o === 'string' ? o : o.label;
}

function defaultParamValue(p: RuleSchemaParam): unknown {
  if (p.type === 'bool') return false;
  if (p.options && p.options.length > 0) return optionValue(p.options[0]);
  return '';
}

function defaultParams(action: RuleSchemaAction | undefined): Record<string, unknown> {
  if (!action) return {};
  return Object.fromEntries(action.params.map((p) => [p.name, defaultParamValue(p)]));
}

function defaultCondition(schema: StatusRuleSchema): StatusRuleCondition {
  const field = schema.condition_fields[0];
  const operator = schema.operators.find((o) => o.needs_value) ?? schema.operators[0];
  return { field: field?.key ?? '', operator: operator?.key ?? '', value: '' };
}

function defaultAction(schema: StatusRuleSchema): StatusRuleAction {
  const def = schema.actions[0];
  return { action_type: def?.key ?? '', params: defaultParams(def) };
}

function ValueControl({ fieldType, fieldOptions, operatorKey, schema, value, label, onChange }: {
  fieldType: string | undefined;
  fieldOptions: SchemaOption[] | undefined;
  operatorKey: string;
  schema: StatusRuleSchema;
  value: string | null;
  label: string;
  onChange: (v: string | null) => void;
}) {
  const operator = schema.operators.find((o) => o.key === operatorKey);
  if (operator?.needs_value === false) return null;
  if (fieldOptions) {
    return (
      <select aria-label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select…</option>
        {fieldOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }
  if (fieldType === 'bool') {
    return (
      <select aria-label={label} value={value ?? 'true'} onChange={(e) => onChange(e.target.value)}>
        <option value="true">True</option>
        <option value="false">False</option>
      </select>
    );
  }
  if (fieldType === 'number') {
    return (
      <input aria-label={label} type="number" value={value ?? ''}
             onChange={(e) => onChange(e.target.value)} />
    );
  }
  return (
    <input aria-label={label} type="text" value={value ?? ''}
           onChange={(e) => onChange(e.target.value)} />
  );
}

function ParamControl({ param, value, label, onChange }: {
  param: RuleSchemaParam;
  value: unknown;
  label: string;
  onChange: (v: unknown) => void;
}) {
  if (param.type === 'bool') {
    return (
      <select aria-label={label} value={value ? 'true' : 'false'}
              onChange={(e) => onChange(e.target.value === 'true')}>
        <option value="true">True</option>
        <option value="false">False</option>
      </select>
    );
  }
  return (
    <select aria-label={label} value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}>
      <option value="">Select…</option>
      {(param.options ?? []).map((o) => (
        <option key={optionValue(o)} value={optionValue(o)}>{optText(o)}</option>
      ))}
    </select>
  );
}

export default function RuleEditorModal({ schema, rule, onClose, onSaved }: Props) {
  const isCreate = rule === null;

  const [name, setName] = useState(rule?.name ?? '');
  const [description, setDescription] = useState(rule?.description ?? '');
  const [priority, setPriority] = useState<number>(rule?.priority ?? DEFAULT_PRIORITY);
  const [enabled] = useState<boolean>(rule?.enabled ?? true);
  const [triggerStatus, setTriggerStatus] = useState(rule?.trigger_status ?? '');
  const [triggerMatchType, setTriggerMatchType] = useState(rule?.trigger_match_type ?? '');
  const [conditions, setConditions] = useState<StatusRuleCondition[]>(rule?.conditions ?? []);
  const [actions, setActions] = useState<StatusRuleAction[]>(rule?.actions ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const canSave = name.trim() !== '' && triggerStatus !== '' && triggerMatchType !== ''
    && actions.length > 0;

  const fieldFor = (key: string) => schema.condition_fields.find((f) => f.key === key);
  const actionDefFor = (key: string) => schema.actions.find((a) => a.key === key);

  const updateCondition = (i: number, patch: Partial<StatusRuleCondition>) =>
    setConditions((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));

  const addCondition = () => setConditions((cs) => [...cs, defaultCondition(schema)]);
  const removeCondition = (i: number) => setConditions((cs) => cs.filter((_, idx) => idx !== i));

  const onFieldChange = (i: number, fieldKey: string) => {
    const condition = conditions[i];
    const op = schema.operators.find((o) => o.key === condition?.operator);
    updateCondition(i, { field: fieldKey, value: op?.needs_value === false ? null : '' });
  };

  const onOperatorChange = (i: number, opKey: string) => {
    const op = schema.operators.find((o) => o.key === opKey);
    updateCondition(i, { operator: opKey, value: op?.needs_value === false ? null : '' });
  };

  const addAction = () => setActions((as) => [...as, defaultAction(schema)]);
  const removeAction = (i: number) => setActions((as) => as.filter((_, idx) => idx !== i));
  const moveAction = (i: number, dir: -1 | 1) => setActions((as) => {
    const j = i + dir;
    if (j < 0 || j >= as.length) return as;
    const copy = [...as];
    [copy[i], copy[j]] = [copy[j], copy[i]];
    return copy;
  });

  const onActionTypeChange = (i: number, key: string) => {
    const def = actionDefFor(key);
    setActions((as) => as.map((a, idx) => (idx === i
      ? { action_type: key, params: defaultParams(def) } : a)));
  };

  const setActionParam = (i: number, name: string, value: unknown) =>
    setActions((as) => as.map((a, idx) => (idx === i
      ? { ...a, params: { ...a.params, [name]: value } } : a)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    const body: StatusRuleIn = {
      name: name.trim(), description: description.trim(),
      trigger_status: triggerStatus, trigger_match_type: triggerMatchType,
      priority, enabled, conditions, actions,
    };
    try {
      if (isCreate) {
        await createStatusRule(body);
      } else {
        await updateStatusRule(rule.id, body);
      }
      onSaved();
    } catch (err) {
      setError(msgFor(err));
    } finally {
      setSaving(false);
    }
  };

  const triggerPreview = schema.trigger_statuses.find((o) => o.value === triggerStatus);

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget && !saving) onClose();
    }}>
      <div className="modal-card">
        <div className="modal-head">
          <h3>{isCreate ? 'New rule' : `Edit — ${rule.name}`}</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose} disabled={saving}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form onSubmit={(e) => void submit(e)}>
          <div className="modal-body">

            <div className="modal-section">Basics</div>
            <div className="pf-form">
              <div className="full"><label>Name *</label>
                <input aria-label="Name" value={name} disabled={saving}
                       onChange={(e) => setName(e.target.value)} /></div>
              <div><label>Priority</label>
                <input aria-label="Priority" type="number" value={priority} disabled={saving}
                       onChange={(e) => setPriority(Number(e.target.value))} />
                <p className="set-note" style={{ padding: 0, margin: '6px 0 0' }}>
                  lower runs first
                </p></div>
              <div className="full"><label>Description</label>
                <textarea aria-label="Description" value={description} disabled={saving} rows={2}
                          onChange={(e) => setDescription(e.target.value)} /></div>
            </div>

            <div className="modal-section">Trigger</div>
            <div className="pf-form">
              <div><label>When a scan with status</label>
                <select aria-label="When a scan with status" value={triggerStatus} disabled={saving}
                        onChange={(e) => setTriggerStatus(e.target.value)}>
                  <option value="">Select a status…</option>
                  {schema.trigger_statuses.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                {triggerPreview && (
                  <div className="chips" style={{ marginTop: 8 }}>
                    <span className="chip custom" style={{ '--chip': triggerPreview.color } as never}>
                      <span className="dot" />{triggerPreview.label}
                    </span>
                  </div>
                )}
              </div>
              <div><label>matches a</label>
                <select aria-label="matches a" value={triggerMatchType} disabled={saving}
                        onChange={(e) => setTriggerMatchType(e.target.value)}>
                  <option value="">Select a match type…</option>
                  {schema.match_types.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select></div>
            </div>

            <div className="modal-section">
              Conditions
              <span className="set-note" style={{ display: 'inline', padding: 0, marginLeft: 10 }}>
                All conditions must be true
              </span>
            </div>
            {conditions.map((c, i) => {
              const field = fieldFor(c.field);
              return (
                <div key={i} className="pf-form" style={{
                  gridTemplateColumns: 'repeat(4, 1fr) auto', alignItems: 'end', marginBottom: 10,
                }}>
                  <div><label>Field</label>
                    <select aria-label={`Condition ${i + 1} field`} value={c.field} disabled={saving}
                            onChange={(e) => onFieldChange(i, e.target.value)}>
                      {schema.condition_fields.map((f) => (
                        <option key={f.key} value={f.key}>{f.label}</option>
                      ))}
                    </select></div>
                  <div><label>Operator</label>
                    <select aria-label={`Condition ${i + 1} operator`} value={c.operator} disabled={saving}
                            onChange={(e) => onOperatorChange(i, e.target.value)}>
                      {schema.operators.map((o) => (
                        <option key={o.key} value={o.key}>{o.label}</option>
                      ))}
                    </select></div>
                  <div><label>Value</label>
                    <ValueControl
                      fieldType={field?.type} fieldOptions={field?.options}
                      operatorKey={c.operator} schema={schema} value={c.value}
                      label={`Condition ${i + 1} value`}
                      onChange={(v) => updateCondition(i, { value: v })}
                    /></div>
                  <div />
                  <div>
                    <button type="button" className="mini-btn" disabled={saving}
                            aria-label={`Remove condition ${i + 1}`}
                            onClick={() => removeCondition(i)}>✕</button>
                  </div>
                </div>
              );
            })}
            <button type="button" className="mini-btn" disabled={saving} onClick={addCondition}>
              Add condition
            </button>

            <div className="modal-section">Actions</div>
            {actions.length === 0 && (
              <p className="set-note">Add at least one action.</p>
            )}
            {actions.map((a, i) => {
              const def = actionDefFor(a.action_type);
              return (
                <div key={i} className="pf-form" style={{
                  gridTemplateColumns: '1fr 1fr auto auto auto', alignItems: 'end', marginBottom: 10,
                }}>
                  <div><label>Action</label>
                    <select aria-label={`Action ${i + 1} type`} value={a.action_type} disabled={saving}
                            onChange={(e) => onActionTypeChange(i, e.target.value)}>
                      {schema.actions.map((ad) => (
                        <option key={ad.key} value={ad.key}>{ad.label}</option>
                      ))}
                    </select></div>
                  {def?.params.map((p) => (
                    <div key={p.name}><label>{p.name}</label>
                      <ParamControl
                        param={p} value={a.params[p.name]}
                        label={`Action ${i + 1} ${p.name}`}
                        onChange={(v) => setActionParam(i, p.name, v)}
                      /></div>
                  ))}
                  <div>
                    <button type="button" className="mini-btn" disabled={saving || i === 0}
                            aria-label={`Move action ${i + 1} up`}
                            onClick={() => moveAction(i, -1)}>↑</button>
                  </div>
                  <div>
                    <button type="button" className="mini-btn"
                            disabled={saving || i === actions.length - 1}
                            aria-label={`Move action ${i + 1} down`}
                            onClick={() => moveAction(i, 1)}>↓</button>
                  </div>
                  <div>
                    <button type="button" className="mini-btn" disabled={saving}
                            aria-label={`Remove action ${i + 1}`}
                            onClick={() => removeAction(i)}>✕</button>
                  </div>
                </div>
              );
            })}
            <button type="button" className="mini-btn" disabled={saving} onClick={addAction}>
              Add action
            </button>

          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={!canSave || saving}>
              {saving ? 'Saving…' : (isCreate ? 'Create rule' : 'Save')}
            </button>
            <button className="mini-btn" type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            {error && <span className="pf-error">{error}</span>}
          </div>
        </form>
      </div>
    </div>
  );
}
