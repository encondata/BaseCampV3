/**
 * New / Edit assignment rule: a name, the packet it hands out, and the
 * conditions that must all hold (each condition is a field plus the values
 * it matches; any one of the values will do). Initiative, client, site,
 * partner and person pick through ComboBoxes; site country offers the
 * countries on the sites list; worker role offers the work types. Values are
 * normalized the way the API stores them (ids lowercase, countries upper
 * case). Create needs learning:add, edit learning:change; the page decides.
 */

import { useEffect, useMemo, useState } from 'react';

import {
  createLearningRule, listLearningPackets, patchLearningRule,
  type LearningRule, type PacketListItem,
} from '../../lib/learning';
import { apiErrorText } from '../../lib/learningDoc';
import {
  buildConditions, conditionsComplete, draftsFrom, fieldLabel, RULE_ERRORS, RULE_FIELDS,
  type ConditionDraft, type RuleField,
} from '../../lib/learningRules';
import { naturalCompare } from '../../lib/sites';
import ChipPicker from '../ChipPicker';
import ComboBox from '../ComboBox';
import { Switch } from '../Switch';
import LearningModal from './LearningModal';
import type { LookupKind, RuleLookups } from './useRuleLookups';

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

export default function RuleEditorModal({ rule, lookups, onClose, onSaved }: {
  /** The rule to edit; null starts a new one. */
  rule: LearningRule | null;
  lookups: RuleLookups;
  onClose: () => void;
  onSaved: (rule: LearningRule) => void;
}) {
  const [name, setName] = useState(rule?.name ?? '');
  const [packetId, setPacketId] = useState(rule?.packet_id ?? '');
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [rows, setRows] = useState<ConditionDraft[]>(
    rule ? draftsFrom(rule.conditions) : [{ field: '', values: [] }]);
  const [packets, setPackets] = useState<PacketListItem[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    listLearningPackets()
      .then((p) => { if (alive) setPackets(p); })
      .catch(() => { if (alive) { setPackets([]); setError('Couldn’t load the packets.'); } });
    return () => { alive = false; };
  }, []);

  // the lists behind the conditions the rule already has
  useEffect(() => {
    rows.forEach((r) => { if (r.field && r.field !== 'everyone') lookups.load(r.field as LookupKind); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const packetOptions = useMemo(() => {
    const live = (packets ?? []).map((p) => ({
      value: p.id, label: p.name, sub: plural(p.item_count, 'document'),
    }));
    // an existing rule keeps naming its packet even once that is archived
    if (rule && !live.some((o) => o.value === rule.packet_id)) {
      live.push({ value: rule.packet_id, label: rule.packet_name, sub: 'Archived' });
    }
    return live.sort((a, b) => naturalCompare(a.label, b.label));
  }, [packets, rule]);
  const archivedPacket = rule !== null && packetId === rule.packet_id && rule.packet_archived;

  const setRow = (i: number, next: Partial<ConditionDraft>) =>
    setRows((rs) => rs.map((r, at) => (at === i ? { ...r, ...next } : r)));
  const pickField = (i: number, field: RuleField | '') => {
    setRow(i, { field, values: [] });
    if (field && field !== 'everyone') lookups.load(field as LookupKind);
  };
  const usedElsewhere = (i: number) => new Set(rows.filter((_, at) => at !== i).map((r) => r.field));

  const valid = name.trim() !== '' && packetId !== '' && conditionsComplete(rows);

  const save = async () => {
    setSaving(true);
    setError('');
    const body = {
      name: name.trim(), packet_id: packetId, conditions: buildConditions(rows), enabled,
    };
    try {
      onSaved(rule ? await patchLearningRule(rule.id, body) : await createLearningRule(body));
    } catch (e) {
      setError(apiErrorText(e, RULE_ERRORS));
      setSaving(false);
    }
  };

  return (
    <LearningModal eyebrow="Assignment rules" wide
                   title={rule ? 'Edit assignment rule' : 'New assignment rule'}
                   description="People who match every condition get the packet when they’re added to an initiative, and when you assign by hand."
                   onClose={onClose} busy={saving}
                   footer={(
                     <>
                       <button type="button" className="btn-solid" onClick={() => void save()}
                               disabled={!valid || saving}>
                         {saving ? 'Saving…' : rule ? 'Save rule' : 'Create rule'}
                       </button>
                       <button type="button" className="mini-btn" onClick={onClose} disabled={saving}>Cancel</button>
                       {error && <span className="pf-error">{error}</span>}
                     </>
                   )}>
      <div className="pf-form">
        <div className="full">
          <label htmlFor="lrn-rule-name">Rule name</label>
          <input id="lrn-rule-name" value={name} maxLength={200} disabled={saving}
                 placeholder="e.g. Acme site rules" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="full">
          <label htmlFor="lrn-rule-packet">Packet</label>
          <ComboBox options={packetOptions} value={packetId} onChange={setPacketId} inputId="lrn-rule-packet"
                    placeholder={packets === null ? 'Loading…' : 'Type to search packets…'} disabled={saving} />
          {archivedPacket && (
            <p className="lrn-hint">This packet is archived, so the rule assigns nothing until you pick another.</p>
          )}
        </div>
      </div>

      <div className="lrn-conds">
        <p className="lrn-kicker">When</p>
        {rows.map((row, i) => {
          const used = usedElsewhere(i);
          const kind = row.field && row.field !== 'everyone' ? (row.field as LookupKind) : null;
          const status = kind ? lookups.status(kind) : 'idle';
          const noun = RULE_FIELDS.find((f) => f.key === row.field)?.noun ?? '';
          return (
            <div key={i} className="lrn-cond-block">
              {i > 0 && <span className="lrn-and">and</span>}
              <div className="lrn-cond-line">
                <select aria-label={`Condition ${i + 1} field`} value={row.field} disabled={saving}
                        onChange={(e) => pickField(i, e.target.value as RuleField | '')}>
                  <option value="">Choose a field…</option>
                  {RULE_FIELDS.filter((f) => f.key === row.field || !used.has(f.key)).map((f) => (
                    <option key={f.key} value={f.key}>{f.label}</option>
                  ))}
                </select>
                {row.field === 'everyone' && (
                  <span className="lrn-hint">Everyone who is added to an initiative. No values to pick.</span>
                )}
                {kind && status === 'failed' && (
                  <span className="pf-error">
                    Couldn’t load the {noun}.{' '}
                    <button type="button" className="mini-btn" onClick={() => lookups.retry(kind)}>Try again</button>
                  </span>
                )}
                {rows.length > 1 && (
                  <button type="button" className="mini-btn lrn-cond-remove" disabled={saving}
                          aria-label={`Remove condition ${i + 1}`}
                          onClick={() => setRows((rs) => rs.filter((_, at) => at !== i))}>Remove</button>
                )}
              </div>
              {kind && status !== 'failed' && (
                <div className="lrn-cond-values">
                  <ChipPicker options={lookups.options(kind)} selected={row.values} disabled={saving}
                              onChange={(values) => setRow(i, { values })}
                              ariaLabel={`Condition ${i + 1} values`}
                              placeholder={status === 'loading' ? 'Loading…' : `Add ${fieldLabel(kind).toLowerCase()}…`}
                              note={row.values.length > 1 ? 'Matches any of these.' : undefined} />
                </div>
              )}
            </div>
          );
        })}
        <button type="button" className="mini-btn" disabled={saving || rows.length >= RULE_FIELDS.length}
                onClick={() => setRows((rs) => [...rs, { field: '', values: [] }])}>Add condition</button>
      </div>

      <div className="lrn-toggle lrn-rule-on">
        <span>Rule is on</span>
        <Switch checked={enabled} onChange={setEnabled} disabled={saving} label="Rule is on" />
      </div>
    </LearningModal>
  );
}
