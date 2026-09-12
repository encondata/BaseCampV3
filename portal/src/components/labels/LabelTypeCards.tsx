/**
 * Generate Labels' right column: one checkbox-style `ChoiceCard` per
 * active `type` vocab entry. Every active type renders, even one with no
 * resolved template right now — it's disabled with a hint instead of
 * disappearing, so an operator can see what exists and why it isn't
 * selectable yet (add a template, or link one to this site).
 */
import type { LabelGeneratePreviewType, LabelVocab } from '../../lib/api';
import { ChoiceCard } from '../reports/ReportOptionsLayout';

export default function LabelTypeCards({ vocab, types, selected, onToggle }: {
  vocab: LabelVocab[];
  /** The preview endpoint's per-type resolution — `null` (not yet
   *  loaded, e.g. no initiative picked) renders every card enabled with
   *  no template info, since there's nothing to disable against yet. */
  types: LabelGeneratePreviewType[] | null;
  selected: string[];
  onToggle: (key: string) => void;
}) {
  const byKey = new Map((types ?? []).map((t) => [t.key, t]));

  if (vocab.length === 0) {
    return <p className="page-hint">No active label types — add one under Label Templates.</p>;
  }

  return (
    <div className="rgm-choice-cards" role="group" aria-label="Label types">
      {vocab.map((v) => {
        const resolved = byKey.get(v.key);
        const disabled = !!types && !resolved?.template;
        return (
          <ChoiceCard
            key={v.key}
            variant="checkbox"
            title={v.label}
            description={v.description || 'No description.'}
            selected={selected.includes(v.key)}
            disabled={disabled}
            hint={disabled ? 'No active template for this type.' : undefined}
            onSelect={() => onToggle(v.key)}
          />
        );
      })}
    </div>
  );
}
