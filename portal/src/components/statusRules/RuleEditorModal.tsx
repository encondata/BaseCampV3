/**
 * RuleEditorModal — schema-driven create/edit builder for status rules.
 * Everything the form can offer (trigger statuses, match types,
 * operators, condition fields, actions + their params) comes from the
 * `schema` prop (Task 9's /status-rules/schema payload) — nothing is
 * fetched here for those, so the modal can never drift from the engine's
 * vocabulary. `rule === null` creates via createStatusRule; otherwise
 * saves via updateStatusRule(rule.id, …).
 *
 * Every dropdown is the house ComboBox (type to filter); a yes/no value
 * reads Yes / No and is stored as "true" / "false" (a condition) or true /
 * false (an action's parameter). A new condition on a yes/no field starts
 * at "true". A yes/no field offers the operator "equals": Yes / No already
 * says either way, and another operator can build a rule that never fires
 * (an off-move sighting runs only the rules that say "equals Yes"). One that
 * can be empty (Asset has rails) also offers the two empty checks, is null
 * and is not null, the only way to ask for "unknown" or "known". A stored
 * condition that has any other operator keeps it, its operator box reading
 * blank until another is picked.
 *
 * The Send a notification action's parameters are People and Groups
 * (ChipPickers over the notification recipients and groups, asked for once
 * the rule has such an action) and a Switch for the people watching what the
 * rule matched. A viewer who may not ask for a list (people need
 * notifications:change, groups notifications:view) sees what the rule chose
 * by name, from the rule's own `names`, read-only, with a note saying which
 * permission picking needs; a list that failed to load shows its error and
 * leaves its picker on. A rule has one such action, so once it has one no
 * other action row offers it. A refused save says why through the 422's
 * `reason`.
 *
 * Follows the modal-scrim/modal-card/modal-head/modal-body/modal-foot
 * skeleton from pages/Notifications.tsx's NewGroupModal (lines
 * 352-397), with .modal-section dividers as in SiteEditModal.
 *
 * `enabled` is deliberately not editable here — that's the list's
 * toggle switch (RulesTab); the editor only carries it through on save
 * (defaulting to true for a new rule).
 */

import { useMemo, useState, type FormEvent } from 'react';

import {
  ApiError, createStatusRule, updateStatusRule,
  type RuleSchemaAction, type RuleSchemaField, type RuleSchemaOperator, type RuleSchemaParam,
  type SchemaOption, type StatusRule, type StatusRuleAction, type StatusRuleCondition,
  type StatusRuleIn, type StatusRuleSchema,
} from '../../lib/api';
import { NOTIFY_ACTION } from '../../lib/statusRules';
import ChipPicker from '../ChipPicker';
import ComboBox, { type ComboOption } from '../ComboBox';
import { Switch } from '../Switch';
import '../../styles/status-rules.css';
import { useNotifyTargets, type NotifyTargets } from './useNotifyTargets';

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

/** Why a bad_action was refused (the 422's `reason`), for the reasons that have words of their own. */
const ACTION_REASONS = new Map([
  ['notify_no_recipients', 'Pick people, groups or watchers.'],
  ['unknown_person', 'A chosen person no longer exists.'],
  ['unknown_group', 'A chosen group no longer exists.'],
]);

/** A bad_action says why in `detail.reason` (its code is the same for every action fault). */
function reasonOf(err: ApiError): string | null {
  const detail = err.detail;
  if (typeof detail !== 'object' || detail === null) return null;
  const reason = (detail as { reason?: unknown }).reason;
  return typeof reason === 'string' ? reason : null;
}

const msgFor = (err: unknown): string => {
  if (!(err instanceof ApiError)) return 'Network error — nothing was saved.';
  if (err.code === 'bad_action') {
    const reason = reasonOf(err);
    const words = reason === null ? undefined : ACTION_REASONS.get(reason);
    if (words) return words;
    // A second Send a notification: the editor never offers one, so this is a safety net,
    // told in the house fallback words.
    if (reason === 'notify_twice') return `Request failed (${reason}).`;
  }
  return ERRORS[err.code] ?? `Request failed (${err.code}).`;
};

function optionValue(o: string | SchemaOption): string {
  return typeof o === 'string' ? o : o.value;
}
function optText(o: string | SchemaOption): string {
  return typeof o === 'string' ? o : o.label;
}

const comboOptions = (options: (string | SchemaOption)[] | undefined): ComboOption[] =>
  (options ?? []).map((o) => ({ value: optionValue(o), label: optText(o) }));

/** A yes/no, stored as "true" / "false" (a condition's value) or true / false (a parameter). */
const YES_NO: ComboOption[] = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
];

const WATCHERS = 'watchers';

/** What an action's parameter is called where it isn't just its name. */
const PARAM_LABELS: Record<string, string> = {
  people: 'People',
  groups: 'Groups',
  [WATCHERS]: 'Also people watching the initiative or site',
};

/** The parameters that don't fit the action's line (lists of people and groups, and the
 *  watchers switch) go in a block under it. */
const isListParam = (p: RuleSchemaParam) => p.type === 'people' || p.type === 'groups';
const isSwitchParam = (p: RuleSchemaParam) => p.type === 'bool' && p.name === WATCHERS;

const idsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

function defaultParamValue(p: RuleSchemaParam): unknown {
  if (isListParam(p)) return [];
  if (p.type === 'bool') return false;
  if (p.options && p.options.length > 0) return optionValue(p.options[0]);
  return '';
}

function defaultParams(action: RuleSchemaAction | undefined): Record<string, unknown> {
  if (!action) return {};
  return Object.fromEntries(action.params.map((p) => [p.name, defaultParamValue(p)]));
}

/** What a condition's value starts at: nothing for an operator that takes none, "true" for a
 *  yes/no field (so an untouched one saves what it shows), else empty. */
function startValue(
  field: RuleSchemaField | undefined, operator: RuleSchemaOperator | undefined,
): string | null {
  if (operator?.needs_value === false) return null;
  return field?.type === 'bool' ? 'true' : '';
}

/** The operator every yes/no field offers: Yes / No already says either way, and another one
 *  (not equals, ...) only gives a second way to say it, or builds a rule that never fires: the
 *  engine runs an off-move sighting just for a rule that says "equals Yes". */
const BOOL_OPERATOR = 'equals';

/** The operators a condition on this field offers. A yes/no field offers "equals", and one that
 *  can also be empty (`nullable`: Asset has rails) the operators that take no value as well,
 *  is null and is not null: only they can ask for "unknown" or "known". Any other field offers
 *  every operator. */
const operatorsFor = (
  schema: StatusRuleSchema, field: RuleSchemaField | undefined,
): RuleSchemaOperator[] => {
  if (field?.type !== 'bool') return schema.operators;
  const canBeEmpty = field.nullable === true;
  return schema.operators.filter(
    (o) => o.key === BOOL_OPERATOR || (canBeEmpty && o.needs_value === false),
  );
};

const operatorChoices = (operators: RuleSchemaOperator[]): ComboOption[] =>
  operators.map((o) => ({ value: o.key, label: o.label }));

function defaultCondition(schema: StatusRuleSchema): StatusRuleCondition {
  const field = schema.condition_fields[0];
  const operator = operatorsFor(schema, field).find((o) => o.needs_value) ?? schema.operators[0];
  return {
    field: field?.key ?? '', operator: operator?.key ?? '', value: startValue(field, operator),
  };
}

/** The actions a rule may still add: a rule has one Send a notification, so once it has it,
 *  that isn't offered. */
const offerable = (schema: StatusRuleSchema, hasNotify: boolean): RuleSchemaAction[] =>
  schema.actions.filter((a) => !(hasNotify && a.key === NOTIFY_ACTION));

/** A new action starts on the first one the rule may still add. */
function defaultAction(schema: StatusRuleSchema, hasNotify: boolean): StatusRuleAction {
  const def = offerable(schema, hasNotify)[0];
  return { action_type: def?.key ?? '', params: defaultParams(def) };
}

function ValueControl({
  fieldType, fieldOptions, operatorKey, schema, value, label, disabled, onChange,
}: {
  fieldType: string | undefined;
  fieldOptions: SchemaOption[] | undefined;
  operatorKey: string;
  schema: StatusRuleSchema;
  value: string | null;
  label: string;
  disabled: boolean;
  onChange: (v: string | null) => void;
}) {
  const operator = schema.operators.find((o) => o.key === operatorKey);
  if (operator?.needs_value === false) return null;
  if (fieldOptions) {
    return (
      <ComboBox options={comboOptions(fieldOptions)} value={value ?? ''} onChange={onChange}
                disabled={disabled} ariaLabel={label} />
    );
  }
  if (fieldType === 'bool') {
    return (
      <ComboBox options={YES_NO} value={value ?? ''} onChange={onChange}
                disabled={disabled} ariaLabel={label} />
    );
  }
  if (fieldType === 'number') {
    return (
      <input aria-label={label} type="number" value={value ?? ''} disabled={disabled}
             onChange={(e) => onChange(e.target.value)} />
    );
  }
  return (
    <input aria-label={label} type="text" value={value ?? ''} disabled={disabled}
           onChange={(e) => onChange(e.target.value)} />
  );
}

function ParamControl({ param, value, label, disabled, targets, names, onChange }: {
  param: RuleSchemaParam;
  value: unknown;
  label: string;
  disabled: boolean;
  targets: NotifyTargets;
  /** The names the rule came with, by id: they stand in for a list the viewer may not ask for. */
  names: Record<string, string>;
  onChange: (v: unknown) => void;
}) {
  if (isListParam(param)) {
    const people = param.type === 'people';
    const list = people ? targets.people : targets.groups;
    const selected = idsOf(value);
    // A list the viewer may not ask for offers nothing to pick: the chips are the chosen ids
    // under the names the rule came with (an id with no name reads as itself), and the picker
    // is off, with a note saying what picking needs.
    const unavailable = list.status === 'unavailable';
    const options = unavailable
      ? selected.map((id) => ({ value: id, label: names[id] ?? id }))
      : list.options;
    return (
      <>
        {/* Off until its list is in, so it never offers "No matches." for a list that is on
            its way. A list that failed leaves it on: a chip can still come off. */}
        <ChipPicker options={options} selected={selected} onChange={onChange}
                    disabled={disabled || unavailable || list.status === 'loading'}
                    ariaLabel={label}
                    placeholder={people ? 'Search people…' : 'Search groups…'} />
        {unavailable && (
          <span className="set-note" style={{ display: 'block', padding: 0, margin: '6px 0 0' }}>
            {people
              ? 'Picking people needs permission to change notifications.'
              : 'Picking groups needs permission to view notifications.'}
          </span>
        )}
        {list.status === 'failed' && (
          <span className="pf-error" role="alert">
            {people ? 'Could not load the recipient list.' : 'Could not load the group list.'}
          </span>
        )}
      </>
    );
  }
  if (isSwitchParam(param)) {
    return <Switch checked={value === true} onChange={onChange} disabled={disabled} label={label} />;
  }
  if (param.type === 'bool') {
    return (
      <ComboBox options={YES_NO} value={value ? 'true' : 'false'}
                onChange={(v) => onChange(v === 'true')} disabled={disabled} ariaLabel={label} />
    );
  }
  return (
    <ComboBox options={comboOptions(param.options)} value={String(value ?? '')}
              onChange={onChange} disabled={disabled} ariaLabel={label} />
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

  // One Send a notification per rule, and its people and groups are asked for only once
  // the rule has one.
  const hasNotify = actions.some((a) => a.action_type === NOTIFY_ACTION);
  const targets = useNotifyTargets(hasNotify);
  const canAddAction = offerable(schema, hasNotify).length > 0;

  const triggerOptions = useMemo<ComboOption[]>(
    () => schema.trigger_statuses.map((o) => ({ value: o.value, label: o.label })), [schema]);
  const matchOptions = useMemo<ComboOption[]>(
    () => schema.match_types.map((o) => ({ value: o.value, label: o.label })), [schema]);
  const fieldOptions = useMemo<ComboOption[]>(
    () => schema.condition_fields.map((f) => ({ value: f.key, label: f.label })), [schema]);

  const fieldFor = (key: string) => schema.condition_fields.find((f) => f.key === key);
  const actionDefFor = (key: string) => schema.actions.find((a) => a.key === key);

  const updateCondition = (i: number, patch: Partial<StatusRuleCondition>) =>
    setConditions((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));

  const addCondition = () => setConditions((cs) => [...cs, defaultCondition(schema)]);
  const removeCondition = (i: number) => setConditions((cs) => cs.filter((_, idx) => idx !== i));

  // Picking what a dropdown already holds changes nothing (a native select said nothing then,
  // the ComboBox says it again): the value, or the parameters, stay.
  const onFieldChange = (i: number, fieldKey: string) => {
    const condition = conditions[i];
    if (!condition || condition.field === fieldKey) return;
    const next = fieldFor(fieldKey);
    // Every yes/no field offers "equals" (and not every operator): a condition moved onto
    // one takes it.
    const operatorKey = next?.type === 'bool' ? BOOL_OPERATOR : condition.operator;
    const op = schema.operators.find((o) => o.key === operatorKey);
    updateCondition(i, { field: fieldKey, operator: operatorKey, value: startValue(next, op) });
  };

  const onOperatorChange = (i: number, opKey: string) => {
    const condition = conditions[i];
    if (!condition || condition.operator === opKey) return;
    const op = schema.operators.find((o) => o.key === opKey);
    updateCondition(i, { operator: opKey, value: startValue(fieldFor(condition.field), op) });
  };

  const addAction = () => setActions((as) => [
    ...as, defaultAction(schema, as.some((a) => a.action_type === NOTIFY_ACTION)),
  ]);
  const removeAction = (i: number) => setActions((as) => as.filter((_, idx) => idx !== i));
  const moveAction = (i: number, dir: -1 | 1) => setActions((as) => {
    const j = i + dir;
    if (j < 0 || j >= as.length) return as;
    const copy = [...as];
    [copy[i], copy[j]] = [copy[j], copy[i]];
    return copy;
  });

  const onActionTypeChange = (i: number, key: string) => {
    if (actions[i]?.action_type === key) return;
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
      <div className="modal-card rule-editor-card">
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
                <ComboBox options={triggerOptions} value={triggerStatus} onChange={setTriggerStatus}
                          disabled={saving} ariaLabel="When a scan with status"
                          placeholder="Select a status…" />
                {triggerPreview && (
                  <div className="chips" style={{ marginTop: 8 }}>
                    <span className="chip custom" style={{ '--chip': triggerPreview.color } as never}>
                      <span className="dot" />{triggerPreview.label}
                    </span>
                  </div>
                )}
              </div>
              <div><label>matches a</label>
                <ComboBox options={matchOptions} value={triggerMatchType}
                          onChange={setTriggerMatchType} disabled={saving} ariaLabel="matches a"
                          placeholder="Select a match type…" /></div>
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
                    <ComboBox options={fieldOptions} value={c.field} disabled={saving}
                              ariaLabel={`Condition ${i + 1} field`}
                              onChange={(v) => onFieldChange(i, v)} /></div>
                  <div><label>Operator</label>
                    <ComboBox options={operatorChoices(operatorsFor(schema, field))}
                              value={c.operator} disabled={saving}
                              ariaLabel={`Condition ${i + 1} operator`}
                              onChange={(v) => onOperatorChange(i, v)} /></div>
                  <div><label>Value</label>
                    <ValueControl
                      fieldType={field?.type} fieldOptions={field?.options}
                      operatorKey={c.operator} schema={schema} value={c.value}
                      label={`Condition ${i + 1} value`} disabled={saving}
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
              const params = def?.params ?? [];
              const lineParams = params.filter((p) => !isListParam(p) && !isSwitchParam(p));
              const lists = params.filter(isListParam);
              const switches = params.filter(isSwitchParam);
              const boxed = lists.length + switches.length > 0;
              // Another row's Send a notification is the only reason to leave one out; a row
              // always lists the type it has.
              const otherNotify = actions.some((x, j) => j !== i && x.action_type === NOTIFY_ACTION);
              const typeOptions = schema.actions
                .filter((ad) => ad.key === a.action_type || !(otherNotify && ad.key === NOTIFY_ACTION))
                .map((ad) => ({ value: ad.key, label: ad.label }));
              const control = (p: RuleSchemaParam, label: string) => (
                <ParamControl
                  param={p} value={a.params[p.name]} label={label} disabled={saving}
                  targets={targets} names={rule?.names ?? {}}
                  onChange={(v) => setActionParam(i, p.name, v)}
                />
              );
              return (
                <div key={i} className={`rule-action${boxed ? ' rule-action-boxed' : ''}`}>
                  <div className="pf-form" style={{
                    // One column per rendered cell: type picker, each small param,
                    // then the three buttons — so no cell ever wraps.
                    gridTemplateColumns:
                      `minmax(240px, 2fr)${' minmax(150px, 1fr)'.repeat(lineParams.length)} auto auto auto`,
                    alignItems: 'end',
                  }}>
                    <div><label>Action</label>
                      <ComboBox options={typeOptions} value={a.action_type} disabled={saving}
                                ariaLabel={`Action ${i + 1} type`}
                                onChange={(v) => onActionTypeChange(i, v)} /></div>
                    {lineParams.map((p) => (
                      <div key={p.name}><label>{PARAM_LABELS[p.name] ?? p.name}</label>
                        {control(p, `Action ${i + 1} ${p.name}`)}</div>
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
                  {boxed && (
                    <div className="rule-action-more">
                      {lists.length > 0 && (
                        <div className="pf-form">
                          {lists.map((p) => (
                            <div key={p.name}><label>{PARAM_LABELS[p.name] ?? p.name}</label>
                              {control(p, `Action ${i + 1} ${p.name}`)}</div>
                          ))}
                        </div>
                      )}
                      {switches.map((p) => (
                        <div key={p.name} className="rule-action-switch">
                          <span>{PARAM_LABELS[p.name] ?? p.name}</span>
                          {control(p, PARAM_LABELS[p.name] ?? p.name)}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            <button type="button" className="mini-btn" disabled={saving || !canAddAction}
                    onClick={addAction}>
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
