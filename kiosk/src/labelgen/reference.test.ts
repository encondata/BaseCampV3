/**
 * The reference labels: every case in fixtures/reference.json is a move's
 * sync bodies with the labels the laptop's own Python path printed for
 * them (fixtures/make_reference.py runs the edge's build_plan and
 * render_job). The port must print the same bytes, or the same outcome.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildPlan, renderLabels, type LabelKind, type PlanInput } from './plan';

interface Expected { asset_id: string; zpl: string | null; error: string | null }

interface ReferenceCase {
  name: string;
  assetsJson: string;
  templatesJson: string;
  kind: LabelKind;
  dpi: number;
  /** Set where a ruling makes the port differ: the outcome it gives instead. */
  ruling?: string;
  note?: string;
  plan: {
    template_id: string | null;
    notes: string[];
    available_dpis: number[];
    has_asset_data: boolean;
    fonts: string[];
  };
  expected: Expected[];
}

const ROOT = new URL('../../../', import.meta.url);
const REFERENCE: { source_hash: string; cases: ReferenceCase[] } = JSON.parse(
  readFileSync(new URL('./fixtures/reference.json', import.meta.url), 'utf8'));

/** make_reference.py `source_hash`: sha256 over each file in order of its
 *  repo-relative path, as the path, a newline, the bytes, a newline. */
function sourceHash(): string {
  const labels = 'api/src/serversherpa/labels/';
  const paths = [
    ...readdirSync(new URL(labels, ROOT)).filter((f) => f.endsWith('.py')).map((f) => labels + f),
    'kiosk_laptop/edge/src/edge/labels/generate.py',
  ].sort();
  const hash = createHash('sha256');
  for (const path of paths) {
    hash.update(`${path}\n`);
    hash.update(readFileSync(new URL(path, ROOT)));
    hash.update('\n');
  }
  return hash.digest('hex');
}

describe('reference labels', () => {
  it('were made from the current Python label code', () => {
    expect(sourceHash(),
      'Regenerate kiosk/src/labelgen/fixtures/reference.json (see make_reference.py)')
      .toBe(REFERENCE.source_hash);
  });

  it('cover the cases the suite promises', () => {
    const names = REFERENCE.cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const builtin of ['VEGAS_DESTINATION', 'AMSTERDAM_DESTINATION', 'GENERIC_RACK_AND_RU',
      'FRONT_ASSET_TAG', 'SWITCH_FRONT_TAG']) {
      expect(names.some((n) => n.includes(builtin)), builtin).toBe(true);
    }
    const outcomes = new Set(REFERENCE.cases.flatMap((c) => c.expected.map((e) => e.error)));
    expect(outcomes).toEqual(new Set([null, 'no_template_at_dpi', 'template_failed',
      'template_unsupported']));
  });

  it.each(REFERENCE.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const input: PlanInput = {
      assetsJson: c.assetsJson, templatesJson: c.templatesJson, kind: c.kind, dpi: c.dpi,
    };
    const plan = buildPlan(input);
    expect({
      template_id: plan.templateId, notes: plan.notes, available_dpis: plan.availableDpis,
      has_asset_data: plan.hasAssetData, fonts: plan.fonts,
    }).toEqual(c.plan);
    const ids = plan.jobs.map((j) => j.assetId);
    expect(ids).toEqual(c.expected.map((e) => e.asset_id));

    const results = renderLabels(input, ids);
    expect(results.map((r) => r.fingerprint)).toEqual(plan.jobs.map((j) => j.fingerprint));
    const got = results.map((r): Expected => ({
      asset_id: r.assetId, zpl: r.zpl, error: r.outcome === 'ok' ? null : r.outcome,
    }));
    const want = c.ruling
      ? c.expected.map((e) => ({ asset_id: e.asset_id, zpl: null, error: c.ruling ?? null }))
      : c.expected;
    for (let i = 0; i < want.length; i += 1) {
      expect(got[i], `${c.name}: ${want[i].asset_id}`).toEqual(want[i]);
    }
    expect(got).toHaveLength(want.length);
  });
});
