/**
 * The label Web Worker: runs `buildCore` off the page's thread, so building
 * a move's labels never freezes the kiosk. Loaded by `labelBuild.ts` as a
 * Vite module worker, one per call, terminated once it answers (or when a
 * newer build supersedes it).
 *
 * It imports only pure modules (`buildCore` and, through it, `labelgen`):
 * no IndexedDB, no React. The page reads the stored bodies and writes the
 * results; the worker only computes.
 *
 * Protocol (`WorkerRequest` / `WorkerResponse` in buildCore.ts):
 *   in   {type: 'build', id, input, previous} | {type: 'plan', id, input}
 *   out  {type: 'progress', id, done, total}  (builds only, per batch)
 *        then {type: 'result', id, ...} or {type: 'error', id, message}
 */

import {
  errorMessage, planOnly, runBuild, type WorkerRequest, type WorkerResponse,
} from './buildCore';

/** The worker global, typed by hand: the app compiles against the DOM lib,
 *  and the WebWorker lib can't join it in the same program. */
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
};

scope.onmessage = (event) => {
  const msg = event.data;
  try {
    if (msg.type === 'plan') {
      scope.postMessage({ type: 'result', id: msg.id, plan: planOnly(msg.input) });
      return;
    }
    const result = runBuild(msg.input, msg.previous, (done, total) => {
      scope.postMessage({ type: 'progress', id: msg.id, done, total });
    });
    scope.postMessage({ type: 'result', id: msg.id, ...result });
  } catch (err) {
    scope.postMessage({ type: 'error', id: msg.id, message: errorMessage(err) });
  }
};
