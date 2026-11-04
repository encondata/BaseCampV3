/**
 * The label build's pure core: the shared generator (`labelgen`) run over
 * a whole move in batches, re-rendering only what changed. The expected
 * ZPL is the reference fixture's, which the laptop's own Python printed.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { LabelKind, PlanInput } from '../../labelgen/plan';
import { buildLabelSet, planOnly, templateName } from './buildCore';

interface ReferenceCase {
  name: string;
  assetsJson: string;
  templatesJson: string;
  kind: LabelKind;
  dpi: number;
  expected: { asset_id: string; zpl: string | null; error: string | null }[];
}

const REFERENCE: { cases: ReferenceCase[] } = JSON.parse(
  readFileSync(new URL('../../labelgen/fixtures/reference.json', import.meta.url), 'utf8'));

function referenceCase(name: string): ReferenceCase {
  const c = REFERENCE.cases.find((x) => x.name === name);
  if (!c) throw new Error(`no reference case ${name}`);
  return c;
}

const inputOf = (c: ReferenceCase): PlanInput => ({
  assetsJson: c.assetsJson, templatesJson: c.templatesJson, kind: c.kind, dpi: c.dpi,
});

const TOP = referenceCase('builtin VEGAS_DESTINATION top 203');
const FRONT = referenceCase('builtin FRONT_ASSET_TAG front 203');
const NO_CONTEXT = referenceCase('missing label_context');

describe('buildLabelSet', () => {
  it.each([TOP, FRONT].map((c) => [c.name, c] as const))(
    'renders every job byte-identical to the reference fixture (%s)', (_name, c) => {
      const { plan, rendered, removed } = buildLabelSet(inputOf(c), new Map());
      expect(rendered.map((r) => r.assetId)).toEqual(c.expected.map((e) => e.asset_id));
      for (const [i, want] of c.expected.entries()) {
        expect(rendered[i].zpl, want.asset_id).toBe(want.zpl);
        expect(rendered[i].outcome === 'ok' ? null : rendered[i].outcome).toBe(want.error);
      }
      expect(rendered.map((r) => r.fingerprint)).toEqual(plan.jobs.map((j) => j.fingerprint));
      expect(removed).toEqual([]);
    });

  it('re-renders only assets whose fingerprint changed', () => {
    const first = buildLabelSet(inputOf(TOP), new Map());
    const previous = new Map(first.rendered.map((r) => [r.assetId, r.fingerprint]));
    expect(buildLabelSet(inputOf(TOP), previous).rendered).toEqual([]);

    // one asset's printed name edited in the raw body, nothing else
    const edited = TOP.assetsJson.replace('"name": "SAMPLE-SERVER-01"', '"name": "SAMPLE-SERVER-99"');
    expect(edited).not.toBe(TOP.assetsJson);
    const again = buildLabelSet({ ...inputOf(TOP), assetsJson: edited }, previous);
    expect(again.rendered.map((r) => r.assetId)).toEqual(['a-1']);
    expect(again.rendered[0].zpl).toContain('SAMPLE-SERVER-99');
    expect(again.rendered[0].fingerprint).not.toBe(previous.get('a-1'));
  });

  it('lists removed assets but never prunes without asset data', () => {
    const previous = new Map(TOP.expected.map((e) => [e.asset_id, 'x']));
    previous.set('gone-1', 'x');
    expect(buildLabelSet(inputOf(TOP), previous).removed).toEqual(['gone-1']);

    // no label_context: no jobs for want of data, so nothing may be pruned
    const blind = buildLabelSet(inputOf(NO_CONTEXT), previous);
    expect(blind.plan.hasAssetData).toBe(false);
    expect(blind.rendered).toEqual([]);
    expect(blind.removed).toEqual([]);
  });

  it('reports progress up to the job count', () => {
    const calls: [number, number][] = [];
    const { plan, rendered } = buildLabelSet(inputOf(TOP), new Map(),
      (done, total) => calls.push([done, total]), 3);
    const total = plan.jobs.length;
    expect(total).toBe(4);
    expect(rendered).toHaveLength(total);
    expect(calls).toEqual([[0, total], [3, total], [4, total]]);

    // nothing to render: no progress at all (the takeover never shows)
    const quiet: [number, number][] = [];
    const previous = new Map(rendered.map((r) => [r.assetId, r.fingerprint]));
    buildLabelSet(inputOf(TOP), previous, (done, t) => quiet.push([done, t]));
    expect(quiet).toEqual([]);
  });
});

describe('planOnly', () => {
  it('is the generator plan', () => {
    const plan = planOnly(inputOf(FRONT));
    expect(plan.templateId).toBe('front_asset_tag-203');
    expect(plan.jobs.map((j) => j.assetId)).toEqual(FRONT.expected.map((e) => e.asset_id));
  });
});

describe('templateName', () => {
  it('names the template the plan picked, from the body it was built from', () => {
    expect(templateName(TOP.templatesJson, 'vegas_destination-203')).toBe(
      JSON.parse(TOP.templatesJson).templates[0].name);
    expect(templateName(TOP.templatesJson, null)).toBeNull();
    expect(templateName(TOP.templatesJson, 'nope')).toBeNull();
    expect(templateName('not json', 'vegas_destination-203')).toBeNull();
  });
});
