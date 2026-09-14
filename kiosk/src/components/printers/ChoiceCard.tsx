/**
 * Ported from the portal's `components/reports/ReportOptionsLayout.tsx`
 * (a .tsx the kiosk cannot import without bundling a second React) —
 * only the `radio` variant the printer setup wizard uses is kept. Same
 * `rgm-choice-*` classes, so portal/styles/reports.css dresses it.
 *
 * A big selectable card with radio semantics: one `role="radio"` member
 * of its parent's `role="radiogroup"`, arrow keys roving focus and
 * selection between siblings. Roving is found via the closest
 * `[role="radiogroup"]` ancestor, so a group of any size works without
 * each caller wiring its own refs.
 */
import type { KeyboardEvent } from 'react';

export function ChoiceCard({ title, description, selected, onSelect }: {
  title: string; description: string; selected: boolean; onSelect: () => void;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      const group = e.currentTarget.closest('[role="radiogroup"]');
      if (!group) return;
      const cards = Array.from(group.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
      const idx = cards.indexOf(e.currentTarget);
      if (idx === -1) return;
      const dir = (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 1;
      const next = cards[(idx + dir + cards.length) % cards.length];
      next?.focus();
      next?.click();
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      onSelect();
    }
  };
  return (
    <button type="button" role="radio" aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            className={`rgm-choice-card ${selected ? 'on' : ''}`}
            onClick={onSelect} onKeyDown={onKeyDown}>
      <span className="rgm-choice-title">{title}</span>
      <span className="rgm-choice-desc">{description}</span>
    </button>
  );
}

export default ChoiceCard;
