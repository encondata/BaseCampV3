/** The wiki server: `npm run dev:server` in development, `npm start` in
 *  the image. Settings come from the environment (config.ts). */
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

import { makeApi } from './apiClient.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { describeError, log } from './log.js';

const cfg = loadConfig();
const { app, attach, collab } = createApp(cfg, makeApi(cfg));
const server = createServer(app);
attach(server);

server.listen(cfg.port, () => {
  log('info', 'wiki server listening', {
    port: cfg.port,
    apiUrl: cfg.apiUrl,
    staticDir: cfg.staticDir,
    liveEditing: cfg.serviceToken ? 'on' : 'off (WIKI_SERVICE_TOKEN is empty)',
  });
});

/** How long in-flight stores get to finish before the process exits anyway. */
const SHUTDOWN_DEADLINE_MS = 15_000;

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log('info', 'shutting down', { signal });
  setTimeout(() => process.exit(1), SHUTDOWN_DEADLINE_MS).unref();
  server.close();
  try {
    // Closing every connection stores each document that has unsaved
    // changes; Hocuspocus unloads a document once its store lands.
    collab.closeConnections();
    for (let waited = 0; collab.getDocumentsCount() > 0 && waited < 3_000; waited += 100) {
      await sleep(100);
    }
    // What's left is waiting on a retry: unloading makes one final attempt.
    await Promise.allSettled([...collab.documents.values()].map((doc) => collab.unloadDocument(doc)));
    await collab.hooks('onDestroy', { instance: collab });
  } catch (error) {
    log('error', 'shutdown failed', { error: describeError(error) });
  }
  process.exit(0);
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
