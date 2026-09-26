/** The wiki server's HTTP side: the built SPA (with a history fallback to
 *  index.html), /healthz, /internal/render for the API's exports, and the
 *  /collab WebSocket handed to Hocuspocus. */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import { resolve } from 'node:path';

import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer } from 'ws';

import type { WikiApi } from './apiClient.js';
import { createCollab } from './collab.js';
import type { ServerConfig } from './config.js';
import { describeError, log } from './log.js';
import { renderDocHtml } from './render.js';

/** Matches the API's cap on a page's JSON. */
const RENDER_BODY_LIMIT = 5 * 1024 * 1024;

/** Paths the SPA fallback never answers: the server's own endpoints. */
const SERVER_PATHS = /^\/(collab|internal|healthz)(\/|$)/;

/** The API's error shape, so its callers read one format. */
function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ detail: { code, message } });
}

/** Constant-time, whatever the lengths (both sides are hashed first). */
function sameSecret(given: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

function requireServiceToken(expected: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!expected) {
      fail(res, 503, 'internal_disabled', "The wiki server's internal API isn't configured.");
      return;
    }
    const given = req.get('X-Wiki-Service-Token');
    if (!given || !sameSecret(given, expected)) {
      fail(res, 401, 'bad_service_token', 'Bad service token.');
      return;
    }
    next();
  };
}

export function createApp(cfg: ServerConfig, api: WikiApi) {
  const collab = createCollab(cfg, api);
  const staticRoot = resolve(cfg.staticDir);
  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  /** `{doc}` (ProseMirror JSON) → `{html}`. */
  app.post(
    '/internal/render',
    requireServiceToken(cfg.serviceToken),
    express.json({ limit: RENDER_BODY_LIMIT }),
    (req, res) => {
      const doc: unknown = (req.body as { doc?: unknown } | undefined)?.doc;
      let html: string;
      try {
        html = renderDocHtml(doc);
      } catch (error) {
        fail(res, 422, 'bad_doc', `Not a document the wiki schema accepts: ${describeError(error)}`);
        return;
      }
      res.json({ html });
    },
  );

  // Vite fingerprints everything under assets/, so it can be cached for good.
  app.use(express.static(staticRoot, {
    index: false,
    setHeaders: (res, path) => {
      if (path.startsWith(resolve(staticRoot, 'assets'))) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }));

  // History fallback: client-side routes (/n/<id>, /s/<key>, …) get the
  // SPA. A path whose last segment has a dot is a file that doesn't exist,
  // and gets a 404 rather than HTML under a script's name.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (SERVER_PATHS.test(req.path) || /\.[^/]*$/.test(req.path)) return next();
    // `root` keeps send's dotfile check off the directories above it (a
    // checkout under .claude/worktrees would otherwise 404)
    res.sendFile('index.html', { root: staticRoot, headers: { 'Cache-Control': 'no-cache' } },
      (error) => { if (error && !res.headersSent) next(); });
  });

  app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error);
    const type = (error as { type?: string } | null)?.type;
    if (type === 'entity.too.large') {
      fail(res, 413, 'too_large', 'The document is larger than 5 MB.');
    } else if (type === 'entity.parse.failed') {
      fail(res, 400, 'bad_request', "The body isn't valid JSON.");
    } else {
      log('error', 'request failed', { path: req.path, error: describeError(error) });
      fail(res, 500, 'internal_error', 'Something went wrong.');
    }
  });

  /** Route WebSocket upgrades on /collab to Hocuspocus; refuse the rest. */
  function attach(server: Server): void {
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      const { pathname } = new URL(request.url ?? '/', 'http://localhost');
      if (pathname !== '/collab') {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => collab.handleConnection(ws, request));
    });
  }

  return { app, attach, collab };
}
