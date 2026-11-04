/**
 * Columns…: which columns the task sheet shows and in what order. One row
 * per column (shown first, in their order, then the hidden ones in MS
 * Project's order): a Switch, the name, Move up / Move down. ID and Task
 * Name are always shown. Reset to default brings back the default columns
 * and widths. Save stores the choice for this browser (lib/plans/columns),
 * and every open sheet follows it.
 */
import { useState } from 'react';

import { Switch } from '../Switch';
import {
  COLUMN_BY_KEY, DEFAULT_VISIBLE, PLAN_COLUMNS, REQUIRED_COLUMNS, loadColumnPrefs, saveColumnPrefs,
  type ColumnPrefs,
} from '../../lib/plans/columns';
import PlanModal from './PlanModal';

import '../../styles/settings.css';   // .switch

interface Item {
  key: string;
  shown: boolean;
}

/** The shown columns in their order, then the hidden ones in PLAN_COLUMNS order. */
function itemsOf(visible: readonly string[]): Item[] {
  const shown = new Set(visible);
  return [
    ...visible.map((key) => ({ key, shown: true })),
    ...PLAN_COLUMNS.filter((c) => !shown.has(c.key)).map((c) => ({ key: c.key, shown: false })),
  ];
}

export default function ColumnsModal({ onClose }: { onClose: () => void }) {
  const [start] = useState<ColumnPrefs>(() => loadColumnPrefs());
  const [items, setItems] = useState<Item[]>(() => itemsOf(start.visible));
  const [widths, setWidths] = useState(start.widths);

  const move = (at: number, by: -1 | 1) => setItems((list) => {
    const next = [...list];
    [next[at], next[at + by]] = [next[at + by], next[at]];
    return next;
  });
  const toggle = (key: string, shown: boolean) =>
    setItems((list) => list.map((it) => (it.key === key ? { ...it, shown } : it)));
  const reset = () => {
    setItems(itemsOf(DEFAULT_VISIBLE));
    setWidths({});
  };
  const save = () => {
    saveColumnPrefs({ visible: items.filter((it) => it.shown).map((it) => it.key), widths });
    onClose();
  };

  const shownCount = items.filter((it) => it.shown).length;
  return (
    <PlanModal title="Columns" description="Choose the columns the task sheet shows, and their order."
               onClose={onClose}
               footer={(
                 <>
                   <button type="button" className="btn-solid" onClick={save}>Save</button>
                   <button type="button" className="mini-btn" onClick={onClose}>Cancel</button>
                   <button type="button" className="mini-btn pln-foot-end" onClick={reset}>Reset to default</button>
                 </>
               )}>
      <p className="pln-note pln-colpick-count">{shownCount} of {items.length} shown</p>
      <ul className="pln-colpick" aria-label="Columns">
        {items.map((it, at) => {
          const label = COLUMN_BY_KEY.get(it.key)?.label ?? it.key;
          const required = REQUIRED_COLUMNS.has(it.key);
          return (
            <li key={it.key} className={`pln-colpick-item${it.shown ? '' : ' off'}`}>
              <Switch checked={it.shown || required} disabled={required} label={`Show ${label}`}
                      onChange={(on) => toggle(it.key, on)} />
              <span className="pln-colpick-name">{label}</span>
              {required && <span className="pln-note">Always shown</span>}
              <span className="pln-colpick-moves">
                <button type="button" className="mini-btn pln-icon-btn" title="Move up"
                        aria-label={`Move ${label} up`} disabled={at === 0} onClick={() => move(at, -1)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6" /></svg>
                </button>
                <button type="button" className="mini-btn pln-icon-btn" title="Move down"
                        aria-label={`Move ${label} down`} disabled={at === items.length - 1}
                        onClick={() => move(at, 1)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </PlanModal>
  );
}
