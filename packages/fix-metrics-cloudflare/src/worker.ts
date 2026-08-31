// Fix Metrics Cloudflare Worker entry: routing + default (wrangler) fetch export.
//
// Pure dependency on the Worker platform surface (Request/Response, fetch, TextEncoder) only —
// the D1 binding is adapted structurally so tests can run against a SQLite-backed fake
// (in-memory) SqlDatabase without any Cloudflare runtime or credentials.
//
// Routes:
//   GET  /healthz
//   POST /api/v1/events
//   POST /api/v1/snapshots/publish   (controlled snapshot generation/rebuild; GET is read-only)
//   GET  /api/v1/snapshots/latest
//   GET  /api/v1/funnel?snapshotId=<id>
// Static assets (public/index.html) are served by the platform assets binding in wrangler.jsonc.
// assets fallback: when the deployment injects an ASSETS binding (or a test provides a fake),
// any request the router does not own is delegated to it; an asset 404 (or a missing binding)
// falls through to the JSON 404. This keeps the dashboard reachable even when the platform does
// not intercept asset paths.

import { readRuntimeConfig, type RuntimeConfig } from './config.ts';
import { adaptD1 } from './d1-adapter.ts';
import { json, jsonError } from './http.ts';
import { handleEvents } from './ingest.ts';
import { handleFunnel, handleLatest, handlePublish } from './public-api.ts';
import { MetricStore } from './store.ts';

/** Structural view of a Cloudflare static assets binding (env.ASSETS). */
export interface AssetsLike {
  fetch(request: Request): Promise<Response>;
}

export interface WorkerDeps {
  store: MetricStore;
  cfg: RuntimeConfig;
  /** injectable clock for tests; defaults to the real clock */
  now?: () => Date;
  /** optional static assets binding; when absent, unmatched routes return the JSON 404 */
  assets?: AssetsLike;
}

export function createWorker(deps: WorkerDeps): { fetch(request: Request): Promise<Response> } {
  const { store, cfg } = deps;
  const now = deps.now ?? (() => new Date());
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const { pathname } = url;

      if (request.method === 'GET' && pathname === '/healthz') {
        return json({ ok: true, service: 'fix-metrics', mode: cfg.syntheticOnly ? 'synthetic-only' : 'disabled' });
      }
      if (request.method === 'POST' && pathname === '/api/v1/events') {
        return await handleEvents(request, { store, cfg, now });
      }
      if (request.method === 'POST' && pathname === '/api/v1/snapshots/publish') {
        return await handlePublish(request, { store, cfg, now });
      }
      if (request.method === 'GET' && pathname === '/api/v1/snapshots/latest') {
        return await handleLatest(request, { store, cfg, now });
      }
      if (request.method === 'GET' && pathname === '/api/v1/funnel') {
        return await handleFunnel(request, { store, cfg, now });
      }

      // assets fallback: hand the request to the static binding; only a definite 404 (or an
      // unavailable binding) falls through to the router's own JSON 404.
      if (deps.assets) {
        try {
          const assetResponse = await deps.assets.fetch(request);
          if (assetResponse && assetResponse.status !== 404) return assetResponse;
        } catch {
          // binding failed at runtime: fall through to the JSON 404
        }
      }
      return jsonError(404, 'not_found');
    },
  };
}

// Default (wrangler) entry: binds the D1 binding named DB, the ASSETS binding and the
// environment to a worker.
export default {
  async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
    const cfg = readRuntimeConfig(env as unknown as Record<string, string | undefined>);
    const store = new MetricStore(adaptD1(env.DB));
    return createWorker({ store, cfg, assets: env.ASSETS as AssetsLike | undefined }).fetch(request);
  },
} satisfies Record<string, unknown>;

export type Env = {
  DB: unknown;
  ASSETS?: unknown;
  FIX_METRICS_SYNTHETIC_ONLY?: string;
  INGEST_TOKEN_CURRENT?: string;
  INGEST_TOKEN_PREVIOUS?: string;
};