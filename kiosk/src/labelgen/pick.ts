/**
 * Which template a label uses (labels/pick.py):
 * - Top: destination site, then source site, then a global template, then
 *   Generic Rack and RU;
 * - Front: destination site, then a global template.
 *
 * A step with no version at the printer's DPI falls through to the next one
 * and leaves a note saying so. Ties within a step go to the highest
 * `version`, then the newest `updated_at` (compared as Python compares
 * strings), then the first listed. Pure: no DOM, no Intl, no Node.
 */

import { cmpCodePoints } from './py';
import type { PyValue } from './pyjson';

export const GENERIC_FAMILY = 'generic rack and ru';

export type LabelKind = 'top' | 'front';

/** pick.py `TemplateChoice`, as the edge's `_choice` reads a synced
 *  template. `scope` is whatever the sync said (a value that isn't one of
 *  the step names is in no site step). */
export interface TemplateChoice {
  id: string;
  family: string;
  label_type: string;
  dpi_key: string;
  version: number;
  updated_at: string;
  scope: PyValue;
}

const isGeneric = (t: TemplateChoice): boolean => t.family.toLowerCase() === GENERIC_FAMILY;

// Each step: what the note calls it, and which templates it holds.
const STEPS: Record<string, readonly [string, (t: TemplateChoice) => boolean]> = {
  destination: ['The destination site\'s', (t) => t.scope === 'destination' || t.scope === 'both'],
  source: ['The source site\'s', (t) => t.scope === 'source'],
  global: ['The global', (t) => t.scope === 'global' && !isGeneric(t)],
  // the fallback is the move's last resort whatever its site links
  generic: ['The fallback', isGeneric],
};
const ORDER: Record<LabelKind, readonly string[]> = {
  top: ['destination', 'source', 'global', 'generic'],
  front: ['destination', 'global'],
};
const KIND_LABEL: Record<LabelKind, string> = { top: 'Top', front: 'Front' };

/** `max(templates, key=(version, updated_at))`: the first of equals wins. */
function best(templates: readonly TemplateChoice[]): TemplateChoice {
  let top = templates[0];
  for (const t of templates.slice(1)) {
    if (t.version > top.version
      || (t.version === top.version && cmpCodePoints(t.updated_at, top.updated_at) > 0)) top = t;
  }
  return top;
}

/** The template for `kind` at `dpiKey`, and one note per earlier step that
 *  had templates of this kind only at another DPI. */
export function pickTemplate(templates: readonly TemplateChoice[], kind: LabelKind,
  dpiKey: string): [TemplateChoice | null, string[]] {
  const ofKind = templates.filter((t) => t.label_type === kind);
  const notes: string[] = [];
  for (const step of ORDER[kind]) {
    const [who, holds] = STEPS[step];
    const inStep = ofKind.filter(holds);
    if (!inStep.length) continue;
    const atDpi = inStep.filter((t) => t.dpi_key === dpiKey);
    if (atDpi.length) return [best(atDpi), notes];
    notes.push(`${who} ${KIND_LABEL[kind]} template "${best(inStep).family}" `
      + `isn't available at ${dpiKey} DPI.`);
  }
  return [null, notes];
}
