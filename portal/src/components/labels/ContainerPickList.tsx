/**
 * ContainerPickList — Container Labels' Step 2: the initiative's
 * containers as a `dir-list` with a checkbox column (header select-all
 * over the FILTERED rows, indeterminate when some-but-not-all of them are
 * selected), `.dir-search` over name/type, a selection counter, a bulk
 * "Set tag" `.segmented` (shown once at least one row is selected), and a
 * per-row `ContainerTagPicker`. Mirrors V2's own table (checkbox,
 * Container Name, Type, Device Count, Status, Tag) with `ContainerLabelsOptions`
 * sharing this exact component so Reports' Generate flow gets the same
 * picker as the standalone page.
 *
 * Selection/tags stay controlled from the parent (plain array/record, per
 * `lib/containerLabels.ts`'s pure helpers) — this component only computes
 * the filtered view and wires the header/bulk actions to those helpers.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import type { ContainerItem } from '../../lib/api';
import {
  applyBulkTag, containerDisplayName, filterContainers, selectAllFiltered, TAG_CHOICES, toggleSelection,
} from '../../lib/containerLabels';
import { TAG_TYPES, type TagKey } from '../../labels/tagTypes';
import ContainerTagPicker from './ContainerTagPicker';
import '../../styles/directory.css';

const GRID = { gridTemplateColumns: '32px 2fr 1fr 0.7fr 1.1fr 1.3fr' };

export default function ContainerPickList({
  containers, selected, tags, onSelectedChange, onTagsChange, onFilteredChange, disabled = false,
}: {
  containers: ContainerItem[];
  selected: string[];
  tags: Record<string, TagKey>;
  onSelectedChange: (next: string[]) => void;
  onTagsChange: (next: Record<string, TagKey>) => void;
  /** Fired whenever the filtered (currently searched-to) id list changes,
   *  so a parent can derive V2's own "selected ∩ filtered, display order"
   *  labeled set (`lib/containerLabels.ts`'s `labeledContainers`) — the
   *  search term itself stays private state here. */
  onFilteredChange?: (filteredIds: string[]) => void;
  disabled?: boolean;
}) {
  const [term, setTerm] = useState('');
  const headerRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => filterContainers(containers, term), [containers, term]);
  const filteredIds = useMemo(() => filtered.map((c) => c.id), [filtered]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const selectedInFiltered = filteredIds.filter((id) => selectedSet.has(id));
  const allFilteredSelected = filteredIds.length > 0 && selectedInFiltered.length === filteredIds.length;
  const someFilteredSelected = selectedInFiltered.length > 0 && !allFilteredSelected;

  useEffect(() => {
    if (headerRef.current) headerRef.current.indeterminate = someFilteredSelected;
  }, [someFilteredSelected]);

  useEffect(() => {
    onFilteredChange?.(filteredIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredIds]);

  const toggleOne = (id: string) => onSelectedChange(toggleSelection(selected, id));
  const toggleAllFiltered = () => onSelectedChange(selectAllFiltered(filteredIds, !allFilteredSelected));
  const setTag = (id: string, tag: TagKey | null) =>
    onTagsChange(applyBulkTag(tags, [id], tag));
  const bulkTag = (tag: TagKey | null) => onTagsChange(applyBulkTag(tags, selected, tag));

  return (
    <div className="cl-pick">
      <div className="cl-pick-tools">
        <div className="dir-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
               strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input placeholder="Search containers…" value={term} disabled={disabled}
                 onChange={(e) => setTerm(e.target.value)} />
        </div>
        {selected.length > 0 && (
          <span className="chip tag">{selected.length} selected</span>
        )}
      </div>

      {selected.length > 0 && (
        <div className="cl-pick-bulk">
          <span className="cell-sub">Set tag:</span>
          <div className="segmented" role="group" aria-label="Set tag for selected containers">
            <button type="button" disabled={disabled} onClick={() => bulkTag(null)}>None</button>
            {TAG_CHOICES.map((key) => (
              <button key={key} type="button" disabled={disabled} onClick={() => bulkTag(key)}>
                {TAG_TYPES[key].label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="dir-list">
        <div className="list-head" style={GRID}>
          <span className="col-head">
            <input type="checkbox" ref={headerRef} disabled={disabled || filteredIds.length === 0}
                   aria-label="Select all filtered containers"
                   checked={allFilteredSelected} onChange={toggleAllFiltered} />
          </span>
          <span className="col-head">Name</span>
          <span className="col-head">Type</span>
          <span className="col-head">Assets</span>
          <span className="col-head">Status</span>
          <span className="col-head">Tag</span>
        </div>

        {filtered.length === 0 && <div className="dir-empty">No containers match.</div>}

        {filtered.map((c) => {
          const isSelected = selectedSet.has(c.id);
          const name = containerDisplayName(c);
          return (
            <div key={c.id} className="dir-row">
              <div className="row-main" style={GRID}
                   onClick={() => !disabled && toggleOne(c.id)}>
                <div className="cell">
                  <input type="checkbox" checked={isSelected} disabled={disabled}
                         aria-label={`Select ${name}`}
                         onChange={() => toggleOne(c.id)}
                         onClick={(e) => e.stopPropagation()} />
                </div>
                <div className="cell cell-primary">
                  <div className="pn"><b>{name}</b></div>
                </div>
                <div className="cell">
                  {c.type_label
                    ? (
                      <span className="chip custom" style={{ '--chip': c.type_color } as CSSProperties}>
                        {c.type_label}
                      </span>
                    )
                    : <span className="cell-sub">—</span>}
                </div>
                <div className="cell"><span className="mono">{c.asset_count}</span></div>
                <div className="cell">
                  <span className="chip custom" style={{ '--chip': c.status_color } as CSSProperties}>
                    <span className="dot" />{c.status_label}
                  </span>
                </div>
                <div className="cell" onClick={(e) => e.stopPropagation()}>
                  <ContainerTagPicker value={tags[c.id] ?? null} disabled={disabled}
                                       label={`Tag for ${name}`}
                                       onChange={(tag) => setTag(c.id, tag)} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <p className="page-hint">Showing {filtered.length} of {containers.length} containers.</p>
    </div>
  );
}
