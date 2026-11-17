/**
 * The Edit tab on an initiative's full details page: the same fields,
 * Save and Archive/Unarchive as InitiativeEditModal, laid out on the page
 * (both save through useInitiativeEditor). Discard changes puts the form
 * back to the saved initiative. The page keeps this mounted while another
 * tab shows, so a draft survives a look at Assets or People (a refetch
 * from another tab leaves it alone); after this tab's own save the page
 * bumps `savedCount` and the form reloads from the saved initiative.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';

import type { InitiativeItem, OrgRef, SiteItem, StatusValue } from '../../lib/api';
import InitiativeFields from './InitiativeFields';
import { useInitiativeEditor } from './useInitiativeEditor';

export default function InitiativeEditTab({
  initiative, statuses, types, subTypes, shippingTypes, sites, clients, partners,
  isAdmin, savedCount, onSaved,
}: {
  initiative: InitiativeItem;
  statuses: StatusValue[];
  types: StatusValue[];
  subTypes: StatusValue[];
  shippingTypes: StatusValue[];
  sites: SiteItem[];
  clients: OrgRef[];
  partners: OrgRef[];
  isAdmin: boolean;
  /** Bumped by the page once its refetch after this tab's save lands. */
  savedCount: number;
  /** Refetch the page, then bump `savedCount`. */
  onSaved: () => Promise<void> | void;
}) {
  const ed = useInitiativeEditor({ initiative, isAdmin, canChange: true, onSaved });
  const { form, setForm, archived, saving, error, locked, dirty } = ed;
  const [saved, setSaved] = useState(false);

  // after a save the page has refetched: show what was saved
  const firstCount = useRef(savedCount);
  const { discard } = ed;
  useEffect(() => {
    if (savedCount !== firstCount.current) discard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedCount]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    if (await ed.save()) setSaved(true);
  };

  return (
    <form className="idet-edit" onSubmit={(e) => void submit(e)}>
      <div className="idet-edit-body">
        <InitiativeFields
          form={form} setForm={(next) => { setSaved(false); setForm(next); }}
          initiative={initiative}
          statuses={statuses} types={types} subTypes={subTypes}
          shippingTypes={shippingTypes} sites={sites} clients={clients} partners={partners}
          locked={locked} typeLocked={ed.typeLocked} wheelColor={ed.wheelColor}
          kioskPassword={isAdmin}
          typeHint={!isAdmin ? 'Only admins can change the type.' : undefined}
        />
      </div>
      <div className="idet-edit-foot">
        <button className="btn-solid" type="submit" disabled={locked || !dirty}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button className="mini-btn" type="button" onClick={ed.discard}
                disabled={saving || !dirty}>
          Discard changes
        </button>
        <button className="mini-btn danger" type="button" disabled={saving}
                onClick={() => void ed.toggleArchive()}>
          {archived ? 'Unarchive' : 'Archive'}
        </button>
        {error && <span className="pf-error">{error}</span>}
        {!error && saved && !dirty && <span className="set-note" role="status">Saved</span>}
      </div>
    </form>
  );
}
