// @vitest-environment jsdom
/**
 * The web kiosk's label build against fake-indexeddb: the in-thread runner
 * (jsdom has no Worker) over the reference fixture's sync bodies, so every
 * stored label can be held to the ZPL the laptop's Python printed.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  fetchAssetsSyncRaw: vi.fn(),
  fetchPeopleSync: vi.fn(),
  fetchContainersSync: vi.fn(),
  fetchTrucksSync: vi.fn(),
  fetchLabelTemplatesSyncRaw: vi.fn(),
}));
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  ...apiMock,
}));

// The real local database, with two seams: `readRawBody` counts its calls
// (a request that reads the bodies hashes them), and `writeLabelSet` can
// be held before it writes (a build's write in flight).
const dbHooks = vi.hoisted(() => ({
  rawReads: 0,
  beforeWrite: null as null | (() => Promise<void>),
}));
vi.mock('../localDb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../localDb')>();
  return {
    ...actual,
    readRawBody: (...args: Parameters<typeof actual.readRawBody>) => {
      dbHooks.rawReads += 1;
      return actual.readRawBody(...args);
    },
    writeLabelSet: async (...args: Parameters<typeof actual.writeLabelSet>) => {
      const hold = dbHooks.beforeWrite;
      if (hold) await hold();
      return actual.writeLabelSet(...args);
    },
  };
});

import { fingerprint, type LabelKind } from '../../labelgen/plan';
import { SOURCE_HASH } from '../../labelgen/sourceHash';
import type { LabelStationSettings } from '../api';
import { writeKioskSetup } from '../kioskSetup';
import { clearDb, closeDb, deleteRows, getAll, putRows, readMeta, writeMeta } from '../localDb';
import { readSyncStatus, resetSyncStatus, runSync } from '../sync';
import { writeWebLabelKind, writeWebLabelSettings } from '../webLabelSettings';
import { ApiError } from '../api';
import { webLabelBackend } from '../labelBackend';
import {
  LABEL_RETRY_MS, LABELGEN_HASH, LABELS_META_KEY, inThreadLabelBuildRunner, installLabelBuild, labelBuildBusy,
  readWebLabelProblems, readWebLabelStatus, requestLabelBuild, requestLabelPlan, setLabelBuildRunner,
  subscribeWebLabelStatus,
  type LabelBuildJob, type LabelBuildRunner, type WebLabelRow, type WebLabelStatus,
} from './labelBuild';

// ── the reference bodies ───────────────────────────────────────────

interface ReferenceCase {
  name: string;
  assetsJson: string;
  templatesJson: string;
  expected: { asset_id: string; zpl: string | null; error: string | null }[];
}

const REFERENCE: { cases: ReferenceCase[] } = JSON.parse(
  // jsdom's import.meta.url is not a file URL: resolve from __dirname
  readFileSync(join(__dirname, '../../labelgen/fixtures/reference.json'), 'utf8'));

function referenceCase(name: string): ReferenceCase {
  const c = REFERENCE.cases.find((x) => x.name === name);
  if (!c) throw new Error(`no reference case ${name}`);
  return c;
}

const TOP_203 = referenceCase('builtin VEGAS_DESTINATION top 203');
const TOP_300 = referenceCase('builtin VEGAS_DESTINATION top 300');
const FRONT_203 = referenceCase('builtin FRONT_ASSET_TAG front 203');

/** The fixture cases share one assets body. */
const ASSETS_TEXT = TOP_203.assetsJson;

/** The text inside a fixture templates body's `templates` list (one
 *  template each), spliced as text so no number is re-serialized. */
function templatesListText(c: ReferenceCase): string {
  const open = '"templates": [';
  const start = c.templatesJson.indexOf(open) + open.length;
  return c.templatesJson.slice(start, c.templatesJson.lastIndexOf(']'));
}

/** One move's template set: Vegas Destination at 203 and 300 (top) and
 *  Front Asset Tag at 203 (front). */
const TEMPLATES_TEXT = `{"initiative_id": "m-1", "generated_at": "2026-10-19T00:00:00Z", "templates": [${
  [TOP_203, TOP_300, FRONT_203].map(templatesListText).join(', ')}]}`;

const nameOf = (c: ReferenceCase): string => JSON.parse(c.templatesJson).templates[0].name;

const IDLE: WebLabelStatus = {
  state: 'idle', reason: null, total: 0, done: 0, ready: 0, errors: 0, unsupported: 0,
};

// ── setup helpers ──────────────────────────────────────────────────

function setUpMove(initiativeId = 'm-1'): void {
  writeKioskSetup({
    initiativeId, initiativeName: `Move ${initiativeId}`, siteId: 's-1', siteName: 'Site A',
    siteRole: 'destination', scanStatus: 'labeled', scanLabel: 'Labeled',
  });
}

function savePrinter(over: Partial<LabelStationSettings> = {}): void {
  writeWebLabelSettings({
    label_kind: 'top', printer: { type: 'usb', ip: null, model: 'ZD421', serial: 'ZD-1' },
    dpi: 203, offset_x: 0, offset_y: 0, peel: false, ...over,
  });
}

async function storeBodies(
  initiativeId = 'm-1', assets = ASSETS_TEXT, templates = TEMPLATES_TEXT,
  templatesMove = initiativeId,
): Promise<void> {
  await putRows('assets_raw', [{ key: 'body', initiativeId, text: assets }]);
  await putRows('label_templates_raw', [{ key: 'body', initiativeId: templatesMove, text: templates }]);
}

async function labelRows(): Promise<WebLabelRow[]> {
  const rows = await getAll<WebLabelRow>('labels');
  return rows.sort((a, b) => a.asset_id.localeCompare(b.asset_id));
}

/** The in-thread runner, counting builds. */
function countingRunner(): LabelBuildRunner & { builds: number } {
  const r = {
    builds: 0,
    build: (...args: Parameters<LabelBuildRunner['build']>) => {
      r.builds += 1;
      return inThreadLabelBuildRunner.build(...args);
    },
    plan: inThreadLabelBuildRunner.plan,
  };
  return r;
}

/** The in-thread runner, each build held until its gate opens. */
function gatedRunner() {
  const gates: { open: () => void; cancel: ReturnType<typeof vi.fn> }[] = [];
  const runner: LabelBuildRunner = {
    build: (input, previous, onProgress) => {
      let open!: () => void;
      const gate = new Promise<void>((resolve) => { open = resolve; });
      const inner = inThreadLabelBuildRunner.build(input, previous, onProgress);
      inner.result.catch(() => undefined);
      const cancel = vi.fn(() => inner.cancel());
      gates.push({ open, cancel });
      return { result: gate.then(() => inner.result), cancel };
    },
    plan: inThreadLabelBuildRunner.plan,
  };
  return { runner, gates };
}

/** The in-thread runner, each build held before it starts (no progress
 *  at all) until its gate opens. */
function heldRunner() {
  const gates: (() => void)[] = [];
  const runner: LabelBuildRunner = {
    build: (input, previous, onProgress) => {
      let inner: LabelBuildJob | null = null;
      let canceled = false;
      const result = new Promise<void>((resolve) => { gates.push(resolve); }).then(() => {
        if (canceled) throw new Error('superseded');
        inner = inThreadLabelBuildRunner.build(input, previous, onProgress);
        return inner.result;
      });
      return { result, cancel: () => { canceled = true; inner?.cancel(); } };
    },
    plan: inThreadLabelBuildRunner.plan,
  };
  return { runner, gates };
}

/** The in-thread runner, its first `failures` builds failing. */
function failingRunner(failures: number): LabelBuildRunner & { builds: number } {
  const r = {
    builds: 0,
    build: (...args: Parameters<LabelBuildRunner['build']>): LabelBuildJob => {
      r.builds += 1;
      if (r.builds <= failures) {
        return { result: Promise.reject(new Error('the label worker failed to run')), cancel: () => undefined };
      }
      return inThreadLabelBuildRunner.build(...args);
    },
    plan: inThreadLabelBuildRunner.plan,
  };
  return r;
}

/** The sync's four downloads answer with these bodies. */
function syncAnswers(assets = ASSETS_TEXT, templates = TEMPLATES_TEXT): void {
  apiMock.fetchAssetsSyncRaw.mockResolvedValue({ body: JSON.parse(assets), text: assets });
  apiMock.fetchLabelTemplatesSyncRaw.mockResolvedValue({ body: JSON.parse(templates), text: templates });
  apiMock.fetchPeopleSync.mockResolvedValue({ generated_at: '', people: [] });
  apiMock.fetchContainersSync.mockResolvedValue({ initiative_id: 'm-1', generated_at: '', containers: [] });
  apiMock.fetchTrucksSync.mockResolvedValue({ initiative_id: 'm-1', generated_at: '', trucks: [] });
}

async function refusal(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  return (err as ApiError).code;
}

function expectRowsMatch(rows: WebLabelRow[], c: ReferenceCase, kind: LabelKind, dpi: number): void {
  expect(rows.map((r) => r.asset_id)).toEqual(c.expected.map((e) => e.asset_id).sort());
  for (const row of rows) {
    const want = c.expected.find((e) => e.asset_id === row.asset_id)!;
    expect(row.zpl, row.asset_id).toBe(want.zpl);
    expect(row.error).toBe(want.error);
    expect(row).toMatchObject({ label_kind: kind, dpi, initiativeId: 'm-1', template_name: nameOf(c) });
    expect(row.fingerprint).toMatch(/^[0-9a-f]{14}$/);
  }
}

let uninstall: (() => void) | null = null;

beforeEach(async () => {
  uninstall?.();
  uninstall = null;
  closeDb();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  localStorage.clear();
  resetSyncStatus();
  setLabelBuildRunner(null);
  for (const fn of Object.values(apiMock)) fn.mockReset();
  dbHooks.beforeWrite = null;
  // no settings, no move: this settles the module back to idle
  await requestLabelBuild();
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
});

// ── the build ──────────────────────────────────────────────────────

describe('requestLabelBuild', () => {
  it('builds and stores labels once settings, move and raw bodies exist', async () => {
    const runner = countingRunner();
    setLabelBuildRunner(runner);
    setUpMove();
    savePrinter();
    await requestLabelBuild();
    expect(runner.builds).toBe(0);             // no bodies yet: nothing to build from
    expect(readWebLabelStatus()).toEqual({ ...IDLE, blocked: 'not_downloaded' });

    await storeBodies();
    const seen: WebLabelStatus[] = [];
    const off = subscribeWebLabelStatus(() => seen.push(readWebLabelStatus()));
    await requestLabelBuild();
    off();

    expect(runner.builds).toBe(1);
    expectRowsMatch(await labelRows(), TOP_203, 'top', 203);
    expect(seen[0]).toMatchObject({ state: 'running', reason: 'setup', total: 4, done: 0 });
    expect(seen.filter((s) => s.state === 'running').map((s) => s.done)).toContain(4);
    expect(readWebLabelStatus()).toEqual({
      state: 'idle', reason: 'setup', total: 4, done: 4, ready: 4, errors: 0, unsupported: 0,
    });
    const meta = await readMeta(LABELS_META_KEY);
    expect(meta).toMatchObject({
      initiativeId: 'm-1', kind: 'top', dpi: 203, sourceHash: SOURCE_HASH,
      assetsHash: fingerprint([ASSETS_TEXT]), templatesHash: fingerprint([TEMPLATES_TEXT]),
      total: 4, ready: 4, errors: 0, unsupported: 0, problems: {}, templateName: nameOf(TOP_203),
    });
    expect(Array.isArray(meta?.notes)).toBe(true);
    expect(Number.isNaN(Date.parse(String(meta?.builtAt)))).toBe(false);

    // a later sync edits one asset: only it is rendered, as an update
    const edited = ASSETS_TEXT.replace('"name": "SAMPLE-SERVER-01"', '"name": "SAMPLE-SERVER-99"');
    await storeBodies('m-1', edited);
    await requestLabelBuild();
    expect(readWebLabelStatus()).toEqual({
      state: 'idle', reason: 'updates', total: 1, done: 1, ready: 4, errors: 0, unsupported: 0,
    });
    const rows = await labelRows();
    expect(rows.find((r) => r.asset_id === 'a-1')?.zpl).toContain('SAMPLE-SERVER-99');
    expect((await readMeta(LABELS_META_KEY))?.assetsHash).toBe(fingerprint([edited]));
  });

  it('skips a build when nothing in its key changed', async () => {
    const runner = countingRunner();
    setLabelBuildRunner(runner);
    setUpMove();
    savePrinter();
    await storeBodies();
    await requestLabelBuild();
    expect(runner.builds).toBe(1);

    await requestLabelBuild();
    // offsets and peel are applied when a label is sent: never a rebuild
    savePrinter({ offset_x: 12, offset_y: -4, peel: true });
    await requestLabelBuild();
    expect(runner.builds).toBe(1);
    expect(readWebLabelStatus()).toMatchObject({ state: 'idle', ready: 4, errors: 0 });
  });

  it('shows the stored build\'s counts without rebuilding', async () => {
    setUpMove();
    savePrinter();
    await storeBodies();
    await requestLabelBuild();

    // the printer forgotten (status back to idle), then saved again as it was
    const runner = countingRunner();
    setLabelBuildRunner(runner);
    localStorage.clear();
    setUpMove();
    await requestLabelBuild();
    expect(readWebLabelStatus()).toEqual(IDLE);
    savePrinter();
    await requestLabelBuild();
    expect(runner.builds).toBe(0);
    expect(readWebLabelStatus()).toEqual({ ...IDLE, ready: 4 });
  });

  it('a kind change rebuilds every label with the new kind', async () => {
    setUpMove();
    savePrinter();
    await storeBodies();
    await requestLabelBuild();
    expectRowsMatch(await labelRows(), TOP_203, 'top', 203);

    writeWebLabelKind('front');                // Kiosk Setup's Top/Front step
    await requestLabelBuild();
    expectRowsMatch(await labelRows(), FRONT_203, 'front', 203);
    expect(readWebLabelStatus()).toMatchObject({ state: 'idle', reason: 'updates', total: 4, ready: 4 });
    expect((await readMeta(LABELS_META_KEY))?.templateName).toBe(nameOf(FRONT_203));
  });

  it('a DPI change from saved settings rebuilds', async () => {
    setUpMove();
    savePrinter();
    await storeBodies();
    await requestLabelBuild();

    savePrinter({ dpi: 300 });
    await requestLabelBuild();
    expectRowsMatch(await labelRows(), TOP_300, 'top', 300);

    // a DPI the move has no template for: every label is an error, counted
    savePrinter({ dpi: 600 });
    await requestLabelBuild();
    const rows = await labelRows();
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.zpl === null && r.error === 'no_template_at_dpi' && r.dpi === 600))
      .toBe(true);
    expect(readWebLabelStatus()).toMatchObject({ state: 'idle', ready: 0, errors: 4, unsupported: 0 });
    expect(await readMeta(LABELS_META_KEY)).toMatchObject({
      dpi: 600, ready: 0, errors: 4, problems: { no_template_at_dpi: 4 }, templateName: null,
    });
  });

  it("raw bodies for another move build nothing, and the status says this move's aren't downloaded", async () => {
    const runner = countingRunner();
    setLabelBuildRunner(runner);
    setUpMove('m-1');
    savePrinter();

    await storeBodies('m-2');                  // both bodies from the previous move
    await requestLabelBuild();
    expect(readWebLabelStatus()).toEqual({ ...IDLE, blocked: 'not_downloaded' });
    await storeBodies('m-1', ASSETS_TEXT, TEMPLATES_TEXT, 'm-2');   // templates not yet re-synced
    await requestLabelBuild();
    expect(runner.builds).toBe(0);
    expect(await labelRows()).toEqual([]);
    expect(await readMeta(LABELS_META_KEY)).toBeNull();
    expect(readWebLabelStatus()).toEqual({ ...IDLE, blocked: 'templates_missing' });

    // built for m-1, then set up again on m-2 before its sync: nothing builds
    await storeBodies('m-1');
    await requestLabelBuild();
    expect(runner.builds).toBe(1);
    expect(readWebLabelStatus().blocked).toBeUndefined();
    setUpMove('m-2');
    await requestLabelBuild();
    expect(runner.builds).toBe(1);
    expect(readWebLabelStatus()).toEqual({ ...IDLE, blocked: 'not_downloaded' });
  });

  it("a move change whose templates download failed says this move's templates are missing", async () => {
    setUpMove('m-1');
    savePrinter();
    await storeBodies('m-1');
    // the sync cleared the old move's set when the new one's download failed
    await deleteRows('label_templates_raw', ['body']);
    await requestLabelBuild();
    expect(readWebLabelStatus()).toEqual({ ...IDLE, blocked: 'templates_missing' });
  });

  it('nothing set up is not "not downloaded": no printer, or no move', async () => {
    await storeBodies('m-1');
    setUpMove('m-1');
    await requestLabelBuild();                 // no printer saved
    expect(readWebLabelStatus()).toEqual(IDLE);
    localStorage.clear();
    savePrinter();
    await requestLabelBuild();                 // no move set up
    expect(readWebLabelStatus()).toEqual(IDLE);
  });

  it('a different generator hash re-renders every label', async () => {
    setUpMove();
    savePrinter();
    await storeBodies();
    await requestLabelBuild();
    const meta = await readMeta(LABELS_META_KEY);

    // as if these labels were made by a kiosk build with other Python
    await writeMeta(LABELS_META_KEY, { ...meta, sourceHash: 'old' });
    const seen: WebLabelStatus[] = [];
    const off = subscribeWebLabelStatus(() => seen.push(readWebLabelStatus()));
    await requestLabelBuild();
    off();
    expect(seen[0]).toMatchObject({ state: 'running', reason: 'updates', total: 4, done: 0 });
    expect(readWebLabelStatus()).toMatchObject({
      state: 'idle', reason: 'updates', total: 4, done: 4, ready: 4,
    });
    expect((await readMeta(LABELS_META_KEY))?.sourceHash).toBe(SOURCE_HASH);
    expectRowsMatch(await labelRows(), TOP_203, 'top', 203);
  });

  it('a different TypeScript generator hash re-renders every label', async () => {
    setUpMove();
    savePrinter();
    await storeBodies();
    await requestLabelBuild();
    const meta = await readMeta(LABELS_META_KEY);
    expect(meta?.labelgenHash).toBe(LABELGEN_HASH);
    expect(LABELGEN_HASH).toMatch(/^[0-9a-f]{64}$/);

    // as if these labels were made by a kiosk deploy with other labelgen
    // sources (same Python, so the same SOURCE_HASH)
    await writeMeta(LABELS_META_KEY, { ...meta, labelgenHash: 'old' });
    const seen: WebLabelStatus[] = [];
    const off = subscribeWebLabelStatus(() => seen.push(readWebLabelStatus()));
    await requestLabelBuild();
    off();
    expect(seen[0]).toMatchObject({ state: 'running', reason: 'updates', total: 4, done: 0 });
    expect(readWebLabelStatus()).toMatchObject({ state: 'idle', reason: 'updates', total: 4, ready: 4 });
    expect((await readMeta(LABELS_META_KEY))?.labelgenHash).toBe(LABELGEN_HASH);
    expectRowsMatch(await labelRows(), TOP_203, 'top', 203);
  });

  it('a templates body that changed alone rebuilds', async () => {
    const runner = countingRunner();
    setLabelBuildRunner(runner);
    setUpMove();
    savePrinter();
    await storeBodies();
    await requestLabelBuild();
    expect(runner.builds).toBe(1);

    // the template renamed on the portal: same assets, same labels
    const renamed = TEMPLATES_TEXT.replace(JSON.stringify(nameOf(TOP_203)), '"Vegas, renamed"');
    expect(renamed).not.toBe(TEMPLATES_TEXT);
    await storeBodies('m-1', ASSETS_TEXT, renamed);
    await requestLabelBuild();
    expect(runner.builds).toBe(2);
    expect(await readMeta(LABELS_META_KEY)).toMatchObject({
      templatesHash: fingerprint([renamed]), templateName: 'Vegas, renamed',
    });
  });

  it('a build superseded while its write is in flight is followed up', async () => {
    setUpMove();
    savePrinter();
    await storeBodies();
    await requestLabelBuild();
    expectRowsMatch(await labelRows(), TOP_203, 'top', 203);

    // 203 -> 300, held at its write
    let release!: () => void;
    let holding = false;
    dbHooks.beforeWrite = () => new Promise<void>((resolve) => {
      holding = true;
      release = resolve;
    });
    savePrinter({ dpi: 300 });
    const at300 = requestLabelBuild();
    await vi.waitFor(() => expect(holding).toBe(true));
    dbHooks.beforeWrite = null;

    // -> 203 again: the stored meta (pre-commit) still says 203, so this skips
    savePrinter({ dpi: 203 });
    await requestLabelBuild();
    release();                                 // the 300 write lands after all
    await at300;
    expectRowsMatch(await labelRows(), TOP_203, 'top', 203);
    expect((await readMeta(LABELS_META_KEY))?.dpi).toBe(203);
  });

  it('a move switch re-renders every label for the new move, even an identical one', async () => {
    setUpMove('m-1');
    savePrinter();
    await storeBodies('m-1');
    await requestLabelBuild();

    // set up on m-2, whose bodies happen to be byte-identical: same
    // fingerprints, but no m-1 row may stand in for an m-2 label
    setUpMove('m-2');
    await storeBodies('m-2');
    await requestLabelBuild();
    const rows = await labelRows();
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.initiativeId === 'm-2')).toBe(true);
    expect(readWebLabelStatus()).toMatchObject({ state: 'idle', reason: 'setup', total: 4, ready: 4 });
  });

  it('after Clear local data no build runs and no rows exist', async () => {
    const runner = countingRunner();
    setLabelBuildRunner(runner);
    setUpMove();
    savePrinter();
    await storeBodies();
    uninstall = installLabelBuild();
    await vi.waitFor(async () => expect(await labelRows()).toHaveLength(4));
    expect(runner.builds).toBe(1);

    // the Developer tab's Clear local data, with the printer still saved
    await clearDb();
    resetSyncStatus();
    await requestLabelBuild();
    savePrinter({ dpi: 300 });                 // even a settings change builds nothing now
    await requestLabelBuild();
    expect(runner.builds).toBe(1);
    expect(await labelRows()).toEqual([]);
    expect(await readMeta(LABELS_META_KEY)).toBeNull();
    expect(readWebLabelStatus()).toEqual({ ...IDLE, blocked: 'not_downloaded' });
  });

  it('a build that finishes after Clear local data writes nothing', async () => {
    const { runner, gates } = gatedRunner();
    setLabelBuildRunner(runner);
    setUpMove();
    savePrinter();
    await storeBodies();
    const pending = requestLabelBuild();
    await vi.waitFor(() => expect(gates).toHaveLength(1));

    await clearDb();                           // wiped while the build is in flight
    gates[0].open();
    await pending;
    expect(await labelRows()).toEqual([]);
    expect(await readMeta(LABELS_META_KEY)).toBeNull();
    expect(readWebLabelStatus().state).toBe('idle');
  });

  it('a newer request supersedes a running one', async () => {
    const { runner, gates } = gatedRunner();
    setLabelBuildRunner(runner);
    setUpMove();
    savePrinter();
    await storeBodies();
    const first = requestLabelBuild();
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    expect(readWebLabelStatus().state).toBe('running');

    // the same key again joins the running build
    void requestLabelBuild();
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(gates).toHaveLength(1);
    expect(gates[0].cancel).not.toHaveBeenCalled();

    writeWebLabelKind('front');
    const second = requestLabelBuild();
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    expect(gates[0].cancel).toHaveBeenCalled();
    gates[0].open();
    gates[1].open();
    await Promise.all([first, second]);
    expectRowsMatch(await labelRows(), FRONT_203, 'front', 203);
    expect(readWebLabelStatus()).toMatchObject({ state: 'idle', ready: 4 });
  });
});

// ── a failed build ─────────────────────────────────────────────────

describe('a failed build', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('keeps its error in the status and is retried once, LABEL_RETRY_MS later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const runner = failingRunner(1);
    setLabelBuildRunner(runner);
    setUpMove();
    savePrinter();
    await storeBodies();
    await requestLabelBuild();
    expect(runner.builds).toBe(1);
    expect(readWebLabelStatus()).toEqual({ ...IDLE, error: 'the label worker failed to run' });
    expect(await labelRows()).toEqual([]);

    await vi.advanceTimersByTimeAsync(LABEL_RETRY_MS - 1000);
    expect(runner.builds).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(runner.builds).toBe(2));
    await vi.waitFor(() => expect(labelBuildBusy()).toBe(false));
    expectRowsMatch(await labelRows(), TOP_203, 'top', 203);
    expect(readWebLabelStatus()).toMatchObject({ state: 'idle', ready: 4 });
    expect(readWebLabelStatus().error).toBeUndefined();
  });

  it('is retried only once: a retry that fails too waits for the next sync or settings change', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const runner = failingRunner(2);
    setLabelBuildRunner(runner);
    setUpMove();
    savePrinter();
    await storeBodies();
    await requestLabelBuild();
    await vi.advanceTimersByTimeAsync(LABEL_RETRY_MS);
    await vi.waitFor(() => expect(runner.builds).toBe(2));
    await vi.waitFor(() => expect(labelBuildBusy()).toBe(false));
    expect(readWebLabelStatus().error).toBe('the label worker failed to run');
    await vi.advanceTimersByTimeAsync(LABEL_RETRY_MS * 3);
    expect(runner.builds).toBe(2);

    // the next request (a sync, a printer saved) tries again, and builds
    await requestLabelBuild();
    expect(runner.builds).toBe(3);
    expectRowsMatch(await labelRows(), TOP_203, 'top', 203);
  });

  it('a newer request replaces the pending retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const runner = failingRunner(1);
    setLabelBuildRunner(runner);
    setUpMove();
    savePrinter();
    await storeBodies();
    await requestLabelBuild();
    expect(runner.builds).toBe(1);
    await requestLabelBuild();                 // e.g. a sync finished meanwhile
    expect(runner.builds).toBe(2);
    await vi.advanceTimersByTimeAsync(LABEL_RETRY_MS * 2);
    expect(runner.builds).toBe(2);             // built: nothing left to retry
  });
});

// ── busy ───────────────────────────────────────────────────────────

describe('labelBuildBusy', () => {
  it('is true from the moment a build is requested until that request settles', async () => {
    setUpMove();
    savePrinter();
    await storeBodies();
    expect(labelBuildBusy()).toBe(false);
    const first = requestLabelBuild();
    expect(labelBuildBusy()).toBe(true);       // before reading or hashing anything
    await first;
    expect(labelBuildBusy()).toBe(false);

    // a request that finds nothing to rebuild is busy too while it looks
    const again = requestLabelBuild();
    expect(labelBuildBusy()).toBe(true);
    await again;
    expect(labelBuildBusy()).toBe(false);
  });

  it("a scan between a sync's end and the build's first progress is refused, not the pre-sync label", async () => {
    setUpMove();
    savePrinter();
    await storeBodies();
    await requestLabelBuild();
    expect((await webLabelBackend.getLabel('a-1')).zpl).toContain('SAMPLE-SERVER-01');

    const { runner, gates } = heldRunner();
    setLabelBuildRunner(runner);
    uninstall = installLabelBuild();
    await vi.waitFor(() => expect(labelBuildBusy()).toBe(false));

    // the portal renamed the asset; the sync brings the new body
    const edited = ASSETS_TEXT.replace('"name": "SAMPLE-SERVER-01"', '"name": "SAMPLE-SERVER-99"');
    syncAnswers(edited);
    await runSync('m-1', 'Move m-1');
    expect(readSyncStatus().phase).toBe('done');
    // the build is still reading and hashing: no progress, no takeover yet
    expect(readWebLabelStatus().state).toBe('idle');
    expect(await refusal(webLabelBackend.getLabel('a-1'))).toBe('labels_regenerating');

    // the worker started but hasn't parsed the move yet
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    expect(readWebLabelStatus().state).toBe('idle');
    expect(await refusal(webLabelBackend.getLabel('a-1'))).toBe('labels_regenerating');

    gates[0]();
    await vi.waitFor(() => expect(labelBuildBusy()).toBe(false));
    expect((await webLabelBackend.getLabel('a-1')).zpl).toContain('SAMPLE-SERVER-99');
  });
});

// ── triggers ───────────────────────────────────────────────────────

describe('installLabelBuild', () => {
  it('a sync finishing triggers a build', async () => {
    apiMock.fetchAssetsSyncRaw.mockResolvedValue({ body: JSON.parse(ASSETS_TEXT), text: ASSETS_TEXT });
    apiMock.fetchLabelTemplatesSyncRaw.mockResolvedValue({
      body: JSON.parse(TEMPLATES_TEXT), text: TEMPLATES_TEXT,
    });
    apiMock.fetchPeopleSync.mockResolvedValue({ generated_at: '', people: [] });
    apiMock.fetchContainersSync.mockResolvedValue({ initiative_id: 'm-1', generated_at: '', containers: [] });
    apiMock.fetchTrucksSync.mockResolvedValue({ initiative_id: 'm-1', generated_at: '', trucks: [] });
    const runner = countingRunner();
    setLabelBuildRunner(runner);
    setUpMove();
    savePrinter();
    uninstall = installLabelBuild();

    await runSync('m-1', 'Move m-1');
    expect(readSyncStatus().phase).toBe('done');
    await vi.waitFor(async () => expect(await labelRows()).toHaveLength(4));
    expectRowsMatch(await labelRows(), TOP_203, 'top', 203);
    expect(runner.builds).toBe(1);
  });

  it('builds nothing while a sync is running, then builds once it finishes', async () => {
    let release!: () => void;
    apiMock.fetchAssetsSyncRaw.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve({ body: JSON.parse(ASSETS_TEXT), text: ASSETS_TEXT });
    }));
    apiMock.fetchLabelTemplatesSyncRaw.mockResolvedValue({
      body: JSON.parse(TEMPLATES_TEXT), text: TEMPLATES_TEXT,
    });
    apiMock.fetchPeopleSync.mockResolvedValue({ generated_at: '', people: [] });
    apiMock.fetchContainersSync.mockResolvedValue({ initiative_id: 'm-1', generated_at: '', containers: [] });
    apiMock.fetchTrucksSync.mockResolvedValue({ initiative_id: 'm-1', generated_at: '', trucks: [] });
    const runner = countingRunner();
    setLabelBuildRunner(runner);
    setUpMove();
    savePrinter();
    await storeBodies();
    uninstall = installLabelBuild();
    await vi.waitFor(async () => expect(await labelRows()).toHaveLength(4));
    expect(runner.builds).toBe(1);

    const syncing = runSync('m-1', 'Move m-1');
    expect(readSyncStatus().phase).toBe('running');
    writeWebLabelKind('front');                // would rebuild, but the bodies are being replaced
    await requestLabelBuild();
    expect(runner.builds).toBe(1);
    expect(readWebLabelStatus().state).toBe('idle');

    release();
    await syncing;
    await vi.waitFor(async () => {
      expect((await labelRows()).every((r) => r.label_kind === 'front')).toBe(true);
    });
    expect(runner.builds).toBe(2);
  });

  it('a label settings change triggers a build', async () => {
    setUpMove();
    savePrinter();
    await storeBodies();
    uninstall = installLabelBuild();
    await vi.waitFor(async () => expect(await labelRows()).toHaveLength(4));

    writeWebLabelKind('front');
    await vi.waitFor(async () => {
      expect((await labelRows()).every((r) => r.label_kind === 'front')).toBe(true);
    });
    expectRowsMatch(await labelRows(), FRONT_203, 'front', 203);
  });

  it('an offsets-or-peel save neither reads the bodies nor builds', async () => {
    const runner = countingRunner();
    setLabelBuildRunner(runner);
    setUpMove();
    savePrinter();
    await storeBodies();
    uninstall = installLabelBuild();
    await vi.waitFor(async () => expect(await labelRows()).toHaveLength(4));
    expect(runner.builds).toBe(1);

    dbHooks.rawReads = 0;
    savePrinter({ offset_x: 12, offset_y: -4, peel: true });   // Test Label Alignment saves
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(dbHooks.rawReads).toBe(0);
    expect(runner.builds).toBe(1);

    savePrinter({ offset_x: 12, offset_y: -4, peel: true, dpi: 300 });
    await vi.waitFor(async () => {
      expect((await labelRows()).every((r) => r.dpi === 300)).toBe(true);
    });
    expect(dbHooks.rawReads).toBeGreaterThan(0);
    expect(runner.builds).toBe(2);
  });

  it('stops listening once uninstalled', async () => {
    const runner = countingRunner();
    setLabelBuildRunner(runner);
    setUpMove();
    savePrinter();
    await storeBodies();
    const off = installLabelBuild();
    await vi.waitFor(async () => expect(await labelRows()).toHaveLength(4));
    off();

    writeWebLabelKind('front');
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(runner.builds).toBe(1);
    expectRowsMatch(await labelRows(), TOP_203, 'top', 203);
  });
});

// ── the plan ───────────────────────────────────────────────────────

describe('requestLabelPlan', () => {
  it('plans from the stored bodies at any DPI and kind', async () => {
    setUpMove();
    await storeBodies();
    expect((await requestLabelPlan({ dpi: 300, kind: 'top' }))?.templateId).toBe('vegas_destination-300');
    expect((await requestLabelPlan({ dpi: 203, kind: 'front' }))?.templateId).toBe('front_asset_tag-203');
    const none = await requestLabelPlan({ dpi: 600, kind: 'top' });
    expect(none?.templateId).toBeNull();
    expect(none?.availableDpis).toEqual([203, 300]);
  });

  it('is null without both bodies for the set-up move', async () => {
    setUpMove();
    expect(await requestLabelPlan({ dpi: 203, kind: 'top' })).toBeNull();
    await storeBodies('m-2');
    expect(await requestLabelPlan({ dpi: 203, kind: 'top' })).toBeNull();
  });
});

describe('readWebLabelProblems', () => {
  it("counts the stored build's labels that couldn't be made, by outcome", async () => {
    setUpMove();
    savePrinter({ label_kind: 'front', dpi: 300 });   // the move has Front at 203 only
    await storeBodies();
    await requestLabelBuild();
    const s = readWebLabelStatus();
    expect(s.ready).toBe(0);
    expect(s.errors).toBeGreaterThan(0);
    expect(await readWebLabelProblems()).toEqual({ no_template_at_dpi: s.errors });
  });

  it('is empty when every label was made', async () => {
    setUpMove();
    savePrinter();
    await storeBodies();
    await requestLabelBuild();
    expect(readWebLabelStatus().errors).toBe(0);
    expect(await readWebLabelProblems()).toEqual({});
  });

  it('is empty for a build of another move, kind or DPI, and with nothing set up', async () => {
    const meta = (over: Record<string, unknown>) => writeMeta(LABELS_META_KEY, {
      initiativeId: 'm-1', kind: 'top', dpi: 203, problems: { template_failed: 2 }, ...over,
    });
    expect(await readWebLabelProblems()).toEqual({});   // no printer, no move
    setUpMove();
    savePrinter();
    await meta({});
    expect(await readWebLabelProblems()).toEqual({ template_failed: 2 });
    await meta({ initiativeId: 'm-2' });
    expect(await readWebLabelProblems()).toEqual({});
    await meta({ kind: 'front' });
    expect(await readWebLabelProblems()).toEqual({});
    await meta({ dpi: 300 });
    expect(await readWebLabelProblems()).toEqual({});
    // a garbled count is left out rather than shown
    await meta({ problems: { template_failed: 'two', no_template_at_dpi: 1 } });
    expect(await readWebLabelProblems()).toEqual({ no_template_at_dpi: 1 });
  });
});
