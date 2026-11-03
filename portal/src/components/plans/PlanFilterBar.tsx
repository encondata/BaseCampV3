/**
 * The filter bar (spec "Views"), between the toolbar and the view: the
 * Filter (an `.org-select` ComboBox), Group by (the Gantt view only) and,
 * at the right, how many tasks match and the `.dir-search` box. Everyone
 * who sees the plan has it, read-only people too. The view it sets (lib/
 * plans/filters) is useSheetView's, kept per plan in this browser
 * (`plans.view.<planId>`).
 *
 * Each control has its hover tip (the house Tip, its words in lib/plans/
 * commandTips). Ctrl+F (⌘F) in the plan focuses the search box
 * (usePlanCommands' `find`); in it Enter goes to the first match and
 * Escape clears the search, or, already clear, goes back to the sheet.
 */
import { useId, type KeyboardEvent, type RefObject } from 'react';

import ComboBox from '../ComboBox';
import { COMMAND_TIPS, tipKeys } from '../../lib/plans/commandTips';
import {
  PLAN_FILTERS, PLAN_GROUPS, type FilterCount, type PlanFilter, type PlanGroupBy, type PlanViewState,
} from '../../lib/plans/filters';
import { detectPlatform, type Platform } from '../../lib/plans/shortcuts';
import Tip from '../Tip';

const FILTER_OPTIONS = PLAN_FILTERS.map((f) => ({ value: f.value, label: f.label }));
const GROUP_OPTIONS = PLAN_GROUPS.map((g) => ({ value: g.value, label: g.label }));
const labelOf = (options: readonly { value: string; label: string }[], value: string) =>
  options.find((o) => o.value === value)?.label;

export interface PlanFilterBarProps {
  view: PlanViewState;
  onChange(change: Partial<PlanViewState>): void;
  /** Group by is offered (the Gantt view). */
  groupable: boolean;
  searchRef: RefObject<HTMLInputElement>;
  /** The tasks that match and the plan's, while a filter or search is on. */
  counts: FilterCount | null;
  /** Enter in the search box: to the first match. */
  onSearchEnter?(): void;
  /** Escape in a clear search box: back to the sheet. */
  onLeave?(): void;
  platform?: Platform;
}

/** "7 of 25 tasks"; that only summaries match (shown, or hidden by Group
 *  by); or that none match. */
export function countText(counts: FilterCount): string {
  if (counts.onlySummaries === 'grouped') return 'Turn off Group by to see summary tasks.';
  if (counts.onlySummaries === 'shown') return 'Only summary tasks match';
  if (!counts.shown) return 'No tasks match';
  return `${counts.shown.toLocaleString()} of ${counts.total.toLocaleString()} task${counts.total === 1 ? '' : 's'}`;
}

export default function PlanFilterBar({
  view, onChange, groupable, searchRef, counts, onSearchEnter, onLeave, platform,
}: PlanFilterBarProps) {
  const id = useId();
  const os = platform ?? detectPlatform();
  const { filter: filterTip, groupBy: groupTip, search: searchTip } = COMMAND_TIPS;

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onSearchEnter?.();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (view.search) onChange({ search: '' });
      else onLeave?.();
    }
  };

  return (
    <div className="pln-filterbar" role="search" aria-label="Filter tasks">
      {/* each tip wraps its control itself, so the control carries the tip's aria-describedby */}
      <div className="pln-fbox">
        <label className="pln-flabel" htmlFor={`${id}-filter`}>{filterTip.label}</label>
        <Tip label={filterTip.label} desc={filterTip.desc}>
          {/* open, the box is for typing: its placeholder still names the filter on now */}
          <ComboBox inputId={`${id}-filter`} options={FILTER_OPTIONS} value={view.filter}
                    placeholder={labelOf(FILTER_OPTIONS, view.filter)}
                    onChange={(v) => onChange({ filter: (v || 'all') as PlanFilter })} />
        </Tip>
      </div>
      {groupable && (
        <div className="pln-fbox">
          <label className="pln-flabel" htmlFor={`${id}-group`}>{groupTip.label}</label>
          <Tip label={groupTip.label} desc={groupTip.desc}>
            <ComboBox inputId={`${id}-group`} options={GROUP_OPTIONS} value={view.group}
                      placeholder={labelOf(GROUP_OPTIONS, view.group)}
                      onChange={(v) => onChange({ group: (v || 'none') as PlanGroupBy })} />
          </Tip>
        </div>
      )}
      <div className="pln-ftools">
        {counts && <span className="result-count pln-fcount" aria-live="polite">{countText(counts)}</span>}
        <div className="dir-search pln-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
               aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <Tip label={searchTip.label} keys={tipKeys('search', os)} desc={searchTip.desc}>
            <input ref={searchRef} value={view.search} placeholder="Search tasks…" aria-label="Search tasks"
                   spellCheck={false} autoComplete="off" onChange={(e) => onChange({ search: e.target.value })}
                   onKeyDown={onSearchKey} />
          </Tip>
        </div>
      </div>
    </div>
  );
}
