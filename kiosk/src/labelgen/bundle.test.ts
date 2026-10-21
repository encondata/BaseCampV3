/**
 * The bundle Android runs (Android_Kiosk_App/app/src/main/assets/labelgen.js):
 * it must be a fresh build of labelgen/index.ts, and it must run in a bare
 * JavaScript engine, with only the ECMAScript built-ins (no DOM, Intl,
 * TextEncoder, Node or timers), through the JSON-string surface alone.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { build, type Rollup } from 'vite';
import { describe, expect, it } from 'vitest';

const BUNDLE = new URL('../../../Android_Kiosk_App/app/src/main/assets/labelgen.js', import.meta.url);
const CONFIG = fileURLToPath(new URL('../../vite.labelgen.config.ts', import.meta.url));
const REFERENCE = JSON.parse(
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

  it('uses nothing beyond the ECMAScript built-ins', () => {
    const code = readFileSync(BUNDLE, 'utf8');
    for (const banned of [/\bIntl\./, /\bTextEncoder\b/, /\bTextDecoder\b/, /\.localeCompare\(/,
      /\.toLocale\w*\(/, /\brequire\(/, /\bprocess\./, /\bwindow\./, /\bdocument\./]) {
      expect(code, String(banned)).not.toMatch(banned);
    }
  });

  it('renders a reference case in a bare engine through JSON strings', () => {
    const context = bareContext();
    expect(vm.runInContext('typeof Intl + typeof TextEncoder + typeof console', context))
      .toBe('undefinedundefinedundefined');
    vm.runInContext(readFileSync(BUNDLE, 'utf8'), context);

    const c = REFERENCE.cases.find((x: { name: string }) => x.name === 'builtin VEGAS_DESTINATION top 300');
    const args = JSON.stringify({
      assetsJson: c.assetsJson, templatesJson: c.templatesJson, kind: c.kind, dpi: c.dpi,
      assetIds: c.expected.map((e: { asset_id: string }) => e.asset_id),
    });
    context.args = args;
    const out = JSON.parse(vm.runInContext('labelgen.renderLabels(args)', context));
    expect(out.error).toBeUndefined();
    expect(out.results.map((r: { assetId: string; zpl: string | null; outcome: string }) => ({
      asset_id: r.assetId, zpl: r.zpl, error: r.outcome === 'ok' ? null : r.outcome,
    }))).toEqual(c.expected);

    const plan = JSON.parse(vm.runInContext(
      `labelgen.buildPlan(${JSON.stringify(args)})`, context));
    expect(plan.templateId).toBe(c.plan.template_id);
    expect(JSON.parse(vm.runInContext('labelgen.buildPlan("[")', context)).error).toBeTruthy();
  });
});
