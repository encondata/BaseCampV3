/**
 * GroupEditModal — add or edit one client group: its name, plus aliases in
 * TagInput's free-text mode. Renaming keeps the old name as an alias on the
 * server, so rows already matched stay matched. Create mode can be seeded
 * from a review value (`seedValue`): the name starts as that value, and when
 * the name is edited the original value is added as an alias too.
 */
import { useState, type FormEvent } from 'react';

import {
  createClientGroup, updateClientGroup, type ClientGroup,
} from '../../lib/api';
import { groupMsgFor } from '../../lib/clientGroups';
import StandardModal from '../StandardModal';
import TagInput from '../TagInput';

export default function GroupEditModal({ clientId, group, seedValue, onClose, onSaved }: {
  clientId: string;
  group?: ClientGroup;
  seedValue?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(group?.name ?? seedValue ?? '');
  const [aliases, setAliases] = useState<string[]>(group?.aliases ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) { setError('Enter a group name.'); return; }
    setSaving(true);
    setError('');
    try {
      if (group) {
        await updateClientGroup(clientId, group.id, { name: trimmed, aliases });
      } else {
        const list = [...aliases];
        if (seedValue && trimmed.toLowerCase() !== seedValue.trim().toLowerCase()
            && !list.some((a) => a.toLowerCase() === seedValue.toLowerCase())) {
          list.push(seedValue);
        }
        await createClientGroup(clientId, { name: trimmed, aliases: list });
      }
      onSaved();
    } catch (err) {
      setError(groupMsgFor(err));
      setSaving(false);
    }
  };

  const title = group ? 'Edit group' : 'Add group';
  return (
    <StandardModal eyebrow="Client groups" title={title} busy={saving} onClose={onClose}
      cardClass="group-modal-card"
      description={group
        ? 'Renaming keeps the old name as an alias, so rows already matched stay matched.'
        : 'Owner values on From-To rows that match the name or an alias join this group.'}
      footer={<>
        <button type="submit" form="group-edit-form" className="btn-solid" disabled={saving}>
          {saving ? 'Saving…' : group ? 'Save' : 'Create group'}
        </button>
        <button type="button" className="mini-btn" onClick={onClose} disabled={saving}>Cancel</button>
        {error && <span className="pf-error">{error}</span>}
      </>}>
      <form id="group-edit-form" className="pf-form" onSubmit={(e) => void submit(e)}>
        <div className="full"><label htmlFor="group-name">Name</label>
          <input id="group-name" value={name} disabled={saving} autoFocus
                 onChange={(e) => setName(e.target.value)} /></div>
        <div className="full"><label>Aliases</label>
          <TagInput value={aliases} onChange={setAliases} disabled={saving}
                    placeholder="Add an alias…" maxTags={50} /></div>
      </form>
    </StandardModal>
  );
}
