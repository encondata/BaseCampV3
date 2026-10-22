/**
 * The bundle Android runs (Android_Kiosk_App/app/src/main/assets/labelgen.js)
 * and its byte copy for iOS (IOS_Kiosk_App/.../Resources/labelgen.js):
 * both must be a fresh build of labelgen/index.ts, and it must run in a bare
 * JavaScript engine, with only the ECMAScript built-ins (no DOM, Intl,
 * TextEncoder, Node, timers or console), through the JSON-string surface alone.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { build, type Rollup } from 'vite';
import { describe, expect, it } from 'vitest';

const BUNDLE = new URL('../../../Android_Kiosk_App/app/src/main/assets/labelgen.js', import.meta.url);
/** The iOS app runs the same bytes in JavaScriptCore. */
const IOS_BUNDLE = new URL(
  '../../../IOS_Kiosk_App/ServerSherpa Kiosk/ServerSherpa Kiosk/Resources/labelgen.js', import.meta.url);
const CONFIG = fileURLToPath(new URL('../../vite.labelgen.config.ts', import.meta.url));
interface ReferenceCase {
  name: string;
  assetsJson: string;
  templatesJson: string;
  kind: string;
  dpi: number;
  ruling?: string;
  plan: unknown;
  expected: { asset_id: string; zpl: string | null; error: string | null }[];
}

const REFERENCE: { cases: ReferenceCase[] } = JSON.parse(
  readFileSync(new URL('./fixtures/reference.json', import.meta.url), 'utf8'));

/** The globals a bare engine has: the ECMAScript built-ins. */
const ES_GLOBALS = new Set([
  'globalThis', 'Infinity', 'NaN', 'undefined', 'eval', 'isFinite', 'isNaN', 'parseFloat',
  'parseInt', 'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'escape',
  'unescape', 'Object', 'Function', 'Array', 'Number', 'Boolean', 'String', 'Symbol', 'BigInt',
  'Date', 'RegExp', 'Promise', 'Proxy', 'Reflect', 'JSON', 'Math', 'Map', 'Set', 'WeakMap',
  'WeakSet', 'WeakRef', 'FinalizationRegistry', 'Error', 'AggregateError', 'EvalError',
  'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'ArrayBuffer',
  'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array',
  'BigUint64Array',
]);

/** A fresh context holding nothing but ES_GLOBALS (V8 adds Intl,
 *  WebAssembly, Atomics and others to every context: removed here). */
function bareContext(): vm.Context {
  const context = vm.createContext({});
  vm.runInContext(`for (const name of Object.getOwnPropertyNames(globalThis)) {
    if (!${JSON.stringify([...ES_GLOBALS])}.includes(name)) delete globalThis[name];
  }`, context);
  return context;
}

async function freshBuild(): Promise<string> {
  const out = await build({ configFile: CONFIG, logLevel: 'silent', build: { write: false } });
  const chunks = (Array.isArray(out) ? out : [out]) as Rollup.RollupOutput[];
  const files = chunks.flatMap((o) => o.output);
  expect(files.map((f) => f.fileName)).toEqual(['labelgen.js']);
  const chunk = files[0];
  if (chunk.type !== 'chunk') throw new Error('the bundle is not a chunk');
  return chunk.code;
}

describe('the Android bundle', () => {
  it('is a fresh build of labelgen', async () => {
    const committed = readFileSync(BUNDLE, 'utf8');
    expect(committed === await freshBuild(), 'run npm --prefix kiosk run build:labelgen').toBe(true);
  }, 60_000);

  it('is copied byte for byte to the iOS app, also a fresh build', async () => {
    const ios = readFileSync(IOS_BUNDLE);
    expect(ios.equals(readFileSync(BUNDLE)), 'run npm --prefix kiosk run build:labelgen').toBe(true);
    expect(ios.toString('utf8') === await freshBuild(), 'run npm --prefix kiosk run build:labelgen').toBe(true);
  }, 60_000);

  it('uses nothing beyond the ECMAScript built-ins', () => {
    const code = readFileSync(BUNDLE, 'utf8');
    for (const banned of [/\bIntl\./, /\bTextEncoder\b/, /\bTextDecoder\b/, /\.localeCompare\(/,
      /\.toLocale\w*\(/, /\brequire\(/, /\bprocess\./, /\bwindow\./, /\bdocument\./,
      // host globals, not ECMAScript: the sandbox has none of them
      /\bsetTimeout\b/, /\bsetInterval\b/, /\bstructuredClone\b/, /\batob\b/, /\bbtoa\b/,
      /\bqueueMicrotask\b/, /\bconsole\b/]) {
      expect(code, String(banned)).not.toMatch(banned);
    }
  });

  it('runs in a bare engine and answers errors as JSON', () => {
    const context = bareContext();
    expect(vm.runInContext('typeof Intl + typeof TextEncoder + typeof console', context))
      .toBe('undefinedundefinedundefined');
    vm.runInContext(readFileSync(BUNDLE, 'utf8'), context);
    expect(JSON.parse(vm.runInContext('labelgen.buildPlan("[")', context)).error).toBeTruthy();
  });

  /** Every reference case (reference.test.ts runs them through the source): the same plan and
   *  the same labels through the committed bundle, in one bare engine, by JSON strings alone. */
  it('prints every reference case in a bare engine through JSON strings', () => {
    const context = bareContext();
    vm.runInContext(readFileSync(BUNDLE, 'utf8'), context);
    const run = (fn: string, args: object) => {
      context.args = JSON.stringify(args);
      const out = JSON.parse(vm.runInContext(`labelgen.${fn}(args)`, context));
      expect(out.error, fn).toBeUndefined();
      return out;
    };
    expect(REFERENCE.cases.length).toBeGreaterThan(50);
    for (const c of REFERENCE.cases as ReferenceCase[]) {
      const input = { assetsJson: c.assetsJson, templatesJson: c.templatesJson, kind: c.kind, dpi: c.dpi };
      const plan = run('buildPlan', input);
      expect({
        template_id: plan.templateId, notes: plan.notes, available_dpis: plan.availableDpis,
        has_asset_data: plan.hasAssetData, fonts: plan.fonts,
      }, c.name).toEqual(c.plan);
      const ids = plan.jobs.map((j: { assetId: string }) => j.assetId);
      expect(ids, c.name).toEqual(c.expected.map((e) => e.asset_id));

      const { results } = run('renderLabels', { ...input, assetIds: ids });
      expect(results.map((r: { fingerprint: string }) => r.fingerprint), c.name)
        .toEqual(plan.jobs.map((j: { fingerprint: string }) => j.fingerprint));
      const want = c.ruling
        ? c.expected.map((e) => ({ asset_id: e.asset_id, zpl: null, error: c.ruling ?? null }))
        : c.expected;
      expect(results.map((r: { assetId: string; zpl: string | null; outcome: string }) => ({
        asset_id: r.assetId, zpl: r.zpl, error: r.outcome === 'ok' ? null : r.outcome,
      })), c.name).toEqual(want);
    }
  });
});
