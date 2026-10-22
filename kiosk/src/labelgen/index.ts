/**
 * The label generator's bundle surface for the Android kiosk: the bundle
 * built from this file runs in a JavaScriptEngine sandbox and installs
 * `globalThis.labelgen`.
 *
 * Every function takes ONE argument, a JSON string holding its arguments
 * as an object, and returns a JSON string holding an object: the result,
 * or `{"error": "<message>"}` (nothing is ever thrown across the boundary).
 *   - buildPlan({assetsJson, templatesJson, kind, dpi}) -> Plan
 *   - renderLabels({assetsJson, templatesJson, kind, dpi, assetIds}) -> {results}
 *   - sampleLabel({templatesJson, kind, dpi}) -> {zpl, reason}
 *   - applyPrintSettings({zpl, verticalOffset, horizontalOffset}) -> {zpl} (one copy)
 *   - withPrintMode({zpl, peel}) -> {zpl}
 *   - alignmentTestZpl({widthDots, heightDots, sizeLabel, dpi}) -> {zpl}
 * `assetsJson` and `templatesJson` are the raw sync bodies, as text.
 */

import { buildPlan, renderLabels, type PlanInput } from './plan';
import { alignmentTestZpl, applyPrintSettings, sampleLabel, withPrintMode } from './printing';

/** The surface's version: bumped when a call's arguments or result change. */
export const VERSION = '1';

type Args = Record<string, unknown>;

function str(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== 'string') throw new TypeError(`${key} must be a string`);
  return v;
}

function num(args: Args, key: string): number {
  const v = args[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`${key} must be a number`);
  return v;
}

function planInput(args: Args): PlanInput {
  const kind = str(args, 'kind');
  if (kind !== 'top' && kind !== 'front') throw new TypeError('kind must be "top" or "front"');
  return {
    assetsJson: str(args, 'assetsJson'), templatesJson: str(args, 'templatesJson'), kind,
    dpi: num(args, 'dpi'),
  };
}

/** One surface function: JSON args in, JSON result or error out. */
function call(fn: (args: Args) => unknown): (argsJson: string) => string {
  return (argsJson) => {
    try {
      const args: unknown = JSON.parse(argsJson);
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        throw new TypeError('the arguments must be a JSON object');
      }
      return JSON.stringify(fn(args as Args));
    } catch (e) {
      return JSON.stringify({ error: e instanceof Error ? e.message || e.name : String(e) });
    }
  };
}

export const surface = {
  version: VERSION,
  buildPlan: call((a) => buildPlan(planInput(a))),
  renderLabels: call((a) => {
    const ids = a.assetIds;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
      throw new TypeError('assetIds must be a list of strings');
    }
    return { results: renderLabels(planInput(a), ids) };
  }),
  sampleLabel: call((a) => {
    const { templatesJson, kind, dpi } = planInput({ ...a, assetsJson: '{}' });
    return sampleLabel(templatesJson, kind, dpi);
  }),
  applyPrintSettings: call((a) => ({
    zpl: applyPrintSettings(str(a, 'zpl'),
      { verticalOffset: num(a, 'verticalOffset'), horizontalOffset: num(a, 'horizontalOffset') },
      { singleCopy: true }),
  })),
  withPrintMode: call((a) => {
    if (typeof a.peel !== 'boolean') throw new TypeError('peel must be a boolean');
    return { zpl: withPrintMode(str(a, 'zpl'), a.peel) };
  }),
  alignmentTestZpl: call((a) => ({
    zpl: alignmentTestZpl(num(a, 'widthDots'), num(a, 'heightDots'), str(a, 'sizeLabel'), num(a, 'dpi')),
  })),
};

declare global {
  // eslint-disable-next-line no-var
  var labelgen: typeof surface;
}

globalThis.labelgen = surface;
