/**
 * Generate Labels' "Label types" card — a vertical stack of one row per
 * active `type` vocab entry: a checkbox-style `ChoiceCard` (title +
 * description) plus, once a preview has loaded, a template line under it
 * showing (or letting the operator resolve) that type's template:
 *   - an auto-match with no override → a `chip tag` naming it, and a
 *     "Change" button that swaps the chip for the picker below;
 *   - an explicit override (whether it replaced an auto-match or supplied
 *     one that never existed) → a `chip c-amber` "manual" + the chosen
 *     template's name/version, and "Reset";
 *   - no auto-match but candidates exist → a ComboBox to choose one;
 *   - no auto-match and no candidates → the row itself is disabled, with
 *     a hint instead of a template line.
 * A type stays disabled (not selectable) until it resolves to some
 * template one way or another — `resolvedTemplateId` is the single
 * source of truth both here and for Generate's own gating.
 */
import { useState } from 'react';

import { candidateScopeText, resolvedTemplateId } from '../../lib/generateLabels';
import type { LabelGeneratePreviewType, LabelVocab } from '../../lib/api';
import ComboBox from '../ComboBox';
import { ChoiceCard } from '../reports/ReportOptionsLayout';

/** V2's per-type blurbs, used when the vocabulary row carries no description. */
const FALLBACK_DESCRIPTION: Record<string, string> = {
  front: 'Front asset label with the destination position.',
  top: 'Top label for identification from above.',
  rail: 'Rail label for server positioning.',
  container: 'Container label with the container id and contents.',
};

export default function LabelTypeCards({ vocab, types, selected, onToggle, overrides, onOverride }: {
  vocab: LabelVocab[];
  /** The preview endpoint's per-type resolution — `null` (not yet
   *  loaded, e.g. no initiative picked) renders every card enabled with
   *  no template line, since there's nothing to disable or resolve
   *  against yet. */
  types: LabelGeneratePreviewType[] | null;
  selected: string[];
  onToggle: (key: string) => void;
  /** Operator-chosen template ids, keyed by type — set via the
   *  "Change"/"Choose a template…" combo, cleared via "Reset". */
  overrides: Record<string, string>;
  onOverride: (key: string, templateId: string | null) => void;
}) {
  // Types the operator clicked "Change" on — shows the picker in place of
  // the auto-match chip even though that type is still resolved (via the
  // untouched auto-match) until a new choice actually lands in `overrides`.
  const [changing, setChanging] = useState<Set<string>>(new Set());
  const byKey = new Map((types ?? []).map((t) => [t.key, t]));

  if (vocab.length === 0) {
    return <p className="page-hint">No active label types — add one under Label Templates.</p>;
  }

  return (
    <div className="rgm-choice-cards" role="group" aria-label="Label types">
      {vocab.map((v) => {
        const resolved = byKey.get(v.key);
        const candidates = resolved?.candidates ?? [];
        const overrideId = overrides[v.key];
        const overrideCandidate = overrideId ? candidates.find((c) => c.id === overrideId) : undefined;
        const templateId = resolvedTemplateId(resolved, overrideId);
        const noCandidatesAtAll = !!types && candidates.length === 0 && !resolved?.template;
        const disabled = !!types && !templateId;

        return (
          <div className="glabels-type-row" key={v.key}>
            <ChoiceCard
              variant="checkbox"
              title={v.label}
              description={v.description || FALLBACK_DESCRIPTION[v.key] || 'Uses the active template for this type.'}
              selected={selected.includes(v.key)}
              disabled={disabled}
              hint={noCandidatesAtAll ? 'No active template of this type.' : undefined}
              onSelect={() => onToggle(v.key)}
            />
            {types && !noCandidatesAtAll && (
              <div className="glabels-tpl-line">
                {overrideId && overrideCandidate ? (
                  <>
                    <span className="chip c-amber">manual</span>
                    <span className="cell-sub">{overrideCandidate.name} v{overrideCandidate.version}</span>
                    <button type="button" className="mini-btn" aria-label={`Reset ${v.label} template`}
                            onClick={() => {
                              onOverride(v.key, null);
                              setChanging((cur) => {
                                if (!cur.has(v.key)) return cur;
                                const next = new Set(cur);
                                next.delete(v.key);
                                return next;
                              });
                            }}>
                      Reset
                    </button>
                  </>
                ) : resolved?.template && !changing.has(v.key) ? (
                  <>
                    <span className="chip tag">
                      {resolved.template.name} v{resolved.template.version} · {resolved.template.scope === 'site' ? 'site' : 'global'}
                    </span>
                    <button type="button" className="mini-btn" aria-label={`Change ${v.label} template`}
                            onClick={() => setChanging((cur) => new Set(cur).add(v.key))}>
                      Change
                    </button>
                  </>
                ) : candidates.length > 0 ? (
                  <ComboBox
                    options={candidates.map((c) => ({ value: c.id, label: `${c.name} v${c.version}`, sub: candidateScopeText(c) }))}
                    value=""
                    onChange={(id) => onOverride(v.key, id)}
                    placeholder="Choose a template…"
                  />
                ) : null}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
