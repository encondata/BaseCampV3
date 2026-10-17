/**
 * Kiosk settings on a laptop: the edge holds the laptop's config document
 * and syncs it with the portal on the check-ins it makes (the edge's
 * config_sync.py), so every browser on the laptop shares one config. Each
 * browser here:
 *
 *  - **polls** GET /edge/config every 60 s and applies the document through
 *    `kioskConfig.applyConfig` when the edge's version differs from the one
 *    it last applied (kept as `applied_version` in the sync state);
 *  - **seeds** the edge from its own stores when the edge has no document
 *    yet (`seed: true`: unstamped, not a change, so a portal edit made before
 *    the laptop's first report still wins);
 *  - **sends its edits** with PUT /edge/config, naming the edge version it
 *    started from. When another browser (or the portal) changed the config
 *    first, the edge answers 409 with the current copy: this browser keeps
 *    its own changed fields over that copy, applies the result, and sends it
 *    again.
 *
 * Local sounds go to the portal (through the edge) before any document
 * naming them is sent, as on a web kiosk. The web heartbeat path
 * (`configBeatFields` / `handleConfigReply`) stays inert on a laptop.
 */

import { ApiError, getEdgeConfig, putEdgeConfig, type EdgeConfig } from './api';
import { subscribeAppearance } from './appearance';
import { subscribeCheckpoints } from './checkpointSettings';
import { subscribeDevMode } from './devMode';
import {
  OWNED_SECTIONS, SOUND_UPLOAD_WAIT_MS, applyConfig, collectConfig, isApplyingConfig,
  readConfigState, type ConfigDoc,
} from './kioskConfig';
import { isLaptop } from './platform';
import { remappingSounds, subscribeSoundSettings, uploadLocalSounds } from './sound';

export const LAPTOP_POLL_MS = 60_000;
/** Edits that land together (a slider drag) go in one PUT. */
export const PUSH_DEBOUNCE_MS = 300;
const MAX_TRIES = 3;
/** A local edit the edge hasn't accepted yet survives a reload. */
const PENDING_KEY = 'ss.kiosk.laptopConfigPending';

function isObj(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isEdgeConfig(value: unknown): value is EdgeConfig {
  return isObj(value) && typeof value.version === 'number'
    && (value.doc === null || isObj(value.doc));
}

function readPending(): boolean {
  try { return localStorage.getItem(PENDING_KEY) === '1'; } catch { return false; }
}

function writePending(on: boolean): void {
  try {
    if (on) localStorage.setItem(PENDING_KEY, '1');
    else localStorage.removeItem(PENDING_KEY);
  } catch { /* the next edit sends everything anyway */ }
}

/** Bumped by every local edit, so a PUT can tell whether one landed while
 *  it was in flight. */
let generation = 0;

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(fallback); });
  });
}

const soundsReady = () => withTimeout(uploadLocalSounds(), SOUND_UPLOAD_WAIT_MS, false);

/** The current document with this browser's changed fields on top: a field
 *  of an owned section that differs from `base` (the document this browser
 *  started from) is its edit; everything else is `current`'s. */
function mergeLocal(
  base: Record<string, unknown> | null, local: ConfigDoc, current: Record<string, unknown>,
): ConfigDoc {
  const out: Record<string, unknown> = JSON.parse(JSON.stringify(current));
  for (const name of OWNED_SECTIONS) {
    const mine = local[name];
    if (!isObj(mine)) continue;
    const was = base && isObj(base[name]) ? base[name] as Record<string, unknown> : null;
    const merged: Record<string, unknown> = isObj(out[name]) ? { ...out[name] as object } : {};
    for (const [key, value] of Object.entries(mine)) {
      if (!was || JSON.stringify(was[key]) !== JSON.stringify(value)) merged[key] = value;
    }
    out[name] = merged;
  }
  out.schema = 1;
  return out as ConfigDoc;
}

/** Applies an edge copy unless this browser already holds that version, or
 *  a local edit is waiting to be sent (that edit goes first). */
function adopt(current: EdgeConfig): void {
  if (!isObj(current.doc) || readPending()) return;
  if (current.version === readConfigState().applied_version) return;
  applyConfig(current.doc, current.version);
}

let pushing: Promise<void> | null = null;
let pushAgain = false;

/** Sends the pending local edit (single-flight; never rejects). */
function pushLocal(): Promise<void> {
  if (pushing) {
    pushAgain = true;
    return pushing;
  }
  pushing = (async () => {
    try {
      do {
        pushAgain = false;
        await pushOnce();
      } while (pushAgain && readPending());
    } finally {
      pushing = null;
    }
  })();
  return pushing;
}

async function pushOnce(): Promise<void> {
  for (let tries = 0; tries < MAX_TRIES && readPending(); tries += 1) {
    if (!await soundsReady()) return;            // a local sound isn't on the portal yet
    try {
      let st = readConfigState();
      if (st.applied_version === null) {
        // Never seen the edge's copy: start from it, keeping this browser's edits.
        const current = await getEdgeConfig();
        if (isObj(current.doc)) {
          applyConfig(mergeLocal(st.base, collectConfig(), current.doc), current.version);
          st = readConfigState();
        }
      }
      const gen = generation;
      const doc = collectConfig();
      const out = await putEdgeConfig({
        doc, ...(st.applied_version !== null ? { base_version: st.applied_version } : {}),
      });
      if (gen === generation) {
        writePending(false);
        if (isObj(out.doc)) applyConfig(out.doc, out.version);
        return;
      }
      // another edit landed meanwhile: send again from the accepted version
      if (isObj(out.doc)) {
        applyConfig(mergeLocal(doc, collectConfig(), out.doc), out.version);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && isEdgeConfig(err.detail)
          && isObj(err.detail.doc)) {
        const st = readConfigState();
        applyConfig(mergeLocal(st.base, collectConfig(), err.detail.doc), err.detail.version);
        continue;
      }
      return;                                    // offline or refused: the next poll retries
    }
  }
}

/** One poll of the edge: seed it, send a pending edit, or apply its copy.
 *  Never rejects. */
export async function pollEdgeConfig(): Promise<void> {
  if (!isLaptop()) return;
  try {
    if (readPending()) {
      await pushLocal();
      if (readPending()) return;
    }
    const gen = generation;
    const appliedBefore = readConfigState().applied_version;
    const current = await getEdgeConfig();
    // An edit or a PUT landed while the GET was in flight: its answer may be
    // older than what this browser now holds. The next poll looks again.
    if (gen !== generation || readConfigState().applied_version !== appliedBefore) return;
    if (current.doc === null) {
      if (!await soundsReady()) return;
      const seedGen = generation;
      const seeded = await putEdgeConfig({ doc: collectConfig(), seed: true });
      if (seedGen === generation) adopt(seeded);
      return;
    }
    adopt(current);
  } catch {
    /* the edge is unreachable or the session ended: the next poll retries */
  }
}

let debounce: ReturnType<typeof setTimeout> | null = null;

function onLocalChange(): void {
  if (isApplyingConfig() || remappingSounds()) return;
  generation += 1;
  writePending(true);
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    debounce = null;
    void pushLocal();
  }, PUSH_DEBOUNCE_MS);
}

let stopCurrent: (() => void) | null = null;

/** Starts the laptop's config sync for a signed-in browser: tracks local
 *  edits, polls now and every `intervalMs`. Returns the stop function. A
 *  no-op on a web kiosk. */
export function startLaptopConfigSync(intervalMs: number = LAPTOP_POLL_MS): () => void {
  if (!isLaptop()) return () => undefined;
  stopCurrent?.();
  const offs = [
    subscribeAppearance(onLocalChange),
    subscribeSoundSettings(onLocalChange),
    subscribeCheckpoints(onLocalChange),
    subscribeDevMode(onLocalChange),
  ];
  void pollEdgeConfig();
  const timer = setInterval(() => void pollEdgeConfig(), intervalMs);
  const stop = () => {
    offs.forEach((off) => off());
    clearInterval(timer);
    if (debounce) {
      clearTimeout(debounce);
      debounce = null;
    }
    if (stopCurrent === stop) stopCurrent = null;
  };
  stopCurrent = stop;
  return stop;
}

/** Test helper. */
export function resetLaptopConfigForTest(): void {
  stopCurrent?.();
  stopCurrent = null;
  generation = 0;
  pushing = null;
  pushAgain = false;
  writePending(false);
}
