/**
 * What happens to a label at send time, and the mock-data sample label.
 *
 * `applyPrintSettings` and `alignmentTestZpl` are portal/src/lib/printLabels.ts's
 * and `withPrintMode` kiosk/src/lib/stationPrinter.ts's, verbatim: the
 * bundle can't import either (they sit beside React and storage code), and
 * printing.test.ts holds them equal. Offsets and peel/tear are applied only
 * here, never to a stored label.
 *
 * `sampleLabel` is the server's mock-data test label (api/routes/kiosk.py
 * `kiosk_label_test_render`) on the synced templates: the template the
 * plan would pick, filled with the builder's mock values for a schema 2
 * design (`mockFieldValues`) or the placeholder mocks plus the template's
 * generation rules for anything else. Pure: no DOM, no Intl, no Node.
 */

import { mockFieldValues, PLACEHOLDER_MOCK_VALUES, designFieldKeys } from './fields';
import { applyGenerationRules, type LabelValues } from './labelValues';
import type { LabelKind } from './pick';
import {
  NO_TEMPLATE, renderJob, TEMPLATE_FAILED, type PlanInput, planWithValues,
} from './plan';
import { pyStr } from './py';
import { templateSchema } from './templateFonts';

export interface OffsetSettings {
  verticalOffset: number;
  horizontalOffset: number;
  copies?: number;
}

/** V2's sendZplToPrinter transform, verbatim (`copies` defaults to 1 here:
 *  the station never multiplies a label): ^LS is a shift-LEFT value so
 *  the horizontal offset is negated (positive setting = move right), and a
 *  rightward shift widens ^PW so the layout isn't clipped; ^LT for the
 *  vertical offset; ^PQ copies before ^XZ unless `singleCopy` (blanks and
 *  the alignment test never multiply). */
export function applyPrintSettings(
  zpl: string, s: OffsetSettings, { singleCopy = false }: { singleCopy?: boolean } = {},
): string {
  let out = zpl;
  if (s.horizontalOffset !== 0) {
    const lsValue = -s.horizontalOffset;
    if (/\^LS-?\d+/i.test(out)) out = out.replace(/\^LS-?\d+/i, `^LS${lsValue}`);
    else out = out.replace(/\^XA/i, `^XA\n^LS${lsValue}`);
    if (s.horizontalOffset > 0) {
      out = out.replace(/\^PW(\d+)/i, (_m, w: string) => `^PW${parseInt(w, 10) + s.horizontalOffset}`);
    }
  }
  if (s.verticalOffset !== 0) {
    out = out.replace(/\^XA/i, `^XA\n^LT${s.verticalOffset}`);
  }
  const copies = s.copies ?? 1;
  if (!singleCopy && copies > 1) {
    out = out.replace(/\^XZ/i, `^PQ${copies}^XZ`);
  }
  return out;
}

/** V2's generateAlignmentTestZpl: an outer box 5 dots in at 4-dot
 *  thickness marking the label edge, then 2-dot boxes every 25 dots
 *  inward while both sides stay ≥ 50 dots, and the size/dpi caption
 *  centered on the label. */
export function alignmentTestZpl(widthDots: number, heightDots: number, sizeLabel: string, dpi: number): string {
  const lines = ['^XA', `^PW${widthDots}`, `^LL${heightDots}`, '^LH0,0'];
  const outerInset = 5;
  lines.push(`^FO${outerInset},${outerInset}^GB${widthDots - 2 * outerInset},${heightDots - 2 * outerInset},4^FS`);
  for (let inset = outerInset + 25; widthDots - 2 * inset >= 50 && heightDots - 2 * inset >= 50; inset += 25) {
    lines.push(`^FO${inset},${inset}^GB${widthDots - 2 * inset},${heightDots - 2 * inset},2^FS`);
  }
  lines.push(`^FO0,${Math.round(heightDots / 2) - 12}^A0N,24,24^FB${widthDots},1,0,C,0^FDALIGN ${sizeLabel} ${dpi}DPI^FS`);
  lines.push('^XZ');
  return lines.join('\n');
}

// A label's own print mode: ^MM[<mode>][,<prepeel Y/N>], any case.
const PRINT_MODE_RE = /\^MM[A-Z]?(?:,[A-Z])?/gi;

/** The label printed peel-off (`^MMP`) or tear-off (`^MMT`): any `^MM` the
 *  label carries is dropped, and the station's mode goes right after every
 *  `^XA` (any case, kept as written). It is never saved (no `^JUS`, no
 *  setvar), but the printer keeps it until a label sets another mode or
 *  it restarts. */
export function withPrintMode(zpl: string, peel: boolean): string {
  const mode = peel ? '^MMP' : '^MMT';
  return zpl.replace(PRINT_MODE_RE, '').replace(/\^XA/gi, (xa) => `${xa}${mode}`);
}

/** api/routes/kiosk.py `mock_label_values` without its blank catalog keys
 *  (a blank and a missing key print the same): the placeholder mocks, then
 *  the template's generation rules. */
function placeholderMocks(rules: Parameters<typeof applyGenerationRules>[1]): LabelValues {
  const out: LabelValues = Object.assign(Object.create(null), PLACEHOLDER_MOCK_VALUES);
  applyGenerationRules(out, rules, PLACEHOLDER_MOCK_VALUES.source_raw, PLACEHOLDER_MOCK_VALUES.destination_raw);
  return out;
}

/** The mock-data test label of the template the plan picks for `kind` at
 *  `dpi`: `{zpl, reason: null}`, or `{zpl: null, reason}` where reason is
 *  the pick's notes (no template at this DPI, with why) or an outcome code
 *  (no_template_at_dpi, template_failed, template_unsupported). */
export function sampleLabel(templatesJson: string, kind: LabelKind,
  dpi: number): { zpl: string | null; reason: string | null } {
  const input: PlanInput = { assetsJson: '{}', templatesJson, kind, dpi };
  const plan = planWithValues(input);
  const t = plan.templateJson;
  if (t === null) return { zpl: null, reason: plan.notes.length ? plan.notes.join(' ') : NO_TEMPLATE };
  let values: LabelValues;
  try {
    if (templateSchema(t) >= 2) {
      values = mockFieldValues(pyStr(t.get('label_type')), designFieldKeys(t.get('design')));
    } else {
      values = placeholderMocks(t.get('generation_rules'));
    }
  } catch {
    return { zpl: null, reason: TEMPLATE_FAILED };
  }
  const { zpl, outcome } = renderJob(t, values);
  return outcome === 'ok' ? { zpl, reason: null } : { zpl: null, reason: outcome };
}
