/**
 * The Resource Names cell editor: a popover under the cell holding the
 * house ChipPicker over `plan.resources`, grouped Team / Staff / Partners.
 * A person with neither an email nor an account carries "won’t get
 * reminders" (the plan's reminders reach them by neither).
 *
 * The popover portals into the enclosing `.portal-shell` (the theme tokens
 * live there) with fixed placement under the cell, above it when the room
 * below is short, and follows the cell when the sheet scrolls. It sits
 * above full screen (z 60) with the portaled menus (70).
 *
 * Save, a click outside or tabbing past Save commits; Escape cancels.
 * Escape first closes an open list (the ComboBox marks that one handled),
 * and the Escape that cancels is marked handled too, so it neither leaves
 * full screen nor closes a dialog behind the sheet. Focus stays inside
 * while a commit is in flight (nothing is disabled) and comes back inside
 * on a refusal, so that Escape always lands here.
 */
import {
  useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';

import ChipPicker from '../ChipPicker';
import type { ComboOption } from '../ComboBox';
import type { Assignee, PlanResource } from '../../lib/plans/api';
import { resourceKey } from '../../lib/plans/editOps';
import { keyLike } from '../../lib/plans/sheetKeys';

const GROUP_LABELS: Record<PlanResource['group'], string> = { team: 'Team', staff: 'Staff', partner: 'Partners' };
const GROUP_ORDER: PlanResource['group'][] = ['team', 'staff', 'partner'];
const NO_REMINDERS = 'won’t get reminders';
const WIDTH = 340;
const GAP = 4;
/** Room the popover wants below the cell before it opens above instead. */
const NEEDED = 320;

/** The picker's options: the plan's resources by group, then anyone
 *  assigned who is no longer among them (so their chip keeps a name). */
export function resourceOptions(resources: readonly PlanResource[], assigned: readonly Assignee[]): ComboOption[] {
  const options: ComboOption[] = [];
  for (const group of GROUP_ORDER) {
    for (const r of resources) {
      if (r.group !== group) continue;
      const silent = r.kind === 'person' && !r.has_email && !r.has_account;
      options.push({ value: resourceKey(r), label: r.name, group: GROUP_LABELS[group], sub: silent ? NO_REMINDERS : null });
    }
  }
  const known = new Set(options.map((opt) => opt.value));
  for (const a of assigned) {
    if (!known.has(resourceKey(a))) options.push({ value: resourceKey(a), label: a.name, group: 'Assigned' });
  }
  return options;
}

interface Props {
  options: ComboOption[];
  selected: string[];
  /** The cell the popover hangs from. */
  anchor: HTMLElement;
  pending: boolean;
  error: string | null;
  onChange(keys: string[]): void;
  onSave(refocus: boolean): void;
  onCancel(): void;
}

/** Fixed placement under the cell, or above it when the room below is short. */
function placeUnder(anchor: HTMLElement): CSSProperties {
  const rect = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - WIDTH - 8));
  const below = window.innerHeight - rect.bottom;
  return below < NEEDED && rect.top > below
    ? { left, bottom: window.innerHeight - rect.top + GAP }
    : { left, top: rect.bottom + GAP };
}

export default function ResourcePicker({ options, selected, anchor, pending, error, onChange, onSave, onCancel }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  // placed from the first render: a box still hidden could not take focus
  const [style, setStyle] = useState<CSSProperties>(() => placeUnder(anchor));
  const host = anchor.closest<HTMLElement>('.portal-shell') ?? document.body;

  // follows the cell when the sheet or the page scrolls, or the window resizes
  useLayoutEffect(() => {
    const place = () => setStyle(placeUnder(anchor));
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [anchor]);

  // opens with the list showing
  useEffect(() => {
    ref.current?.querySelector<HTMLInputElement>('input[role="combobox"]')?.focus({ preventScroll: true });
  }, []);

  // a click anywhere else commits, as leaving a cell does
  const save = useRef(onSave);
  save.current = onSave;
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || anchor.contains(target)) return;
      save.current(false);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [anchor]);

  // a refusal: focus back inside (it may have gone with a click elsewhere),
  // so the next Escape closes the picker and not full screen
  useEffect(() => {
    if (error && !ref.current?.contains(document.activeElement)) ref.current?.focus({ preventScroll: true });
  }, [error]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const k = keyLike(e);
    if (k.isComposing) return;          // the IME's own Escape and Tab
    if (k.key === 'Tab' && !k.shiftKey && e.target === saveRef.current) {
      // tabbing past Save leaves the picker as leaving a cell does: it commits
      e.preventDefault();
      onSave(true);
      return;
    }
    if (k.key !== 'Escape') return;
    if (e.defaultPrevented) {
      // an open list took this one and dropped focus: keep it in the
      // popover, so the next Escape lands here and not on full screen
      ref.current?.focus();
      return;
    }
    e.preventDefault();
    onCancel();
  };

  // focus moving to something outside (Shift+Tab off the top) commits too;
  // focus dropped to nowhere (a pick blurs its box for a moment) does not
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && !ref.current?.contains(next) && !anchor.contains(next)) onSave(false);
  };

  // While a commit is in flight nothing is disabled (a disabled field drops
  // focus to the page): the popover is busy and its actions wait.
  return createPortal(
    <div ref={ref} className="pln-respick" role="dialog" aria-label="Resource Names" style={style}
         tabIndex={-1} aria-busy={pending || undefined} onKeyDown={onKeyDown} onBlur={onBlur}>
      <ChipPicker options={options} selected={selected} onChange={(keys) => { if (!pending) onChange(keys); }}
                  placeholder="Add a person or partner…" ariaLabel="Add a resource" clearAll />
      {error && <p className="pf-error" role="alert">{error}</p>}
      <div className="pln-respick-foot">
        <button type="button" className="mini-btn" aria-disabled={pending || undefined}
                onClick={() => { if (!pending) onCancel(); }}>Cancel</button>
        <button ref={saveRef} type="button" className="btn-solid" aria-disabled={pending || undefined}
                onClick={() => { if (!pending) onSave(true); }}>Save</button>
      </div>
    </div>,
    host,
  );
}
