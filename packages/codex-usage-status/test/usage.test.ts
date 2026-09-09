import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UsageController,
  USAGE_STATUS_CONSTANTS,
  extractCodexAuthScope,
  fetchUsageSnapshot,
  formatUsageSnapshot,
  parseUsagePayload,
} from '../src/usage.ts';

function token(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.`;
}

function auth(accountId = 'acct-test'): { auth: { apiKey: string } } {
  return {
    auth: {
      apiKey: token({
        exp: Math.floor(Date.now() / 1000) + 3600,
        'https://api.openai.com/auth': { chatgpt_account_id: accountId },
      }),
    },
  };
}

function payload(accountId = 'acct-test') {
  return {
    account_id: accountId,
    rate_limit: {
      allowed: true,
      primary_window: { used_percent: 28.4, limit_window_seconds: 18000, reset_at: 2000000000 },
      secondary_window: { used_percent: 50, limit_window_seconds: 604800, reset_at: 2000000100 },
    },
    additional_rate_limits: [
      { limit_name: '\u001b[31mbad', rate_limit: { primary_window: { used_percent: 10 } } },
      { metered_feature: 'model-x', rate_limit: { primary_window: { used_percent: 12, reset_at: 2000000200 } } },
      { limit_name: 'z-last', rate_limit: { primary_window: { used_percent: 75 } } },
      { limit_name: 'a-first', rate_limit: { primary_window: { used_percent: 1 } } },
    ],
  };
}

test('projects only the supported wire DTO and sorts additional buckets', () => {
  const snapshot = parseUsagePayload(payload(), 'acct-test', 1234);
  assert.ok(snapshot);
  assert.equal(snapshot.availability, 'allowed');
  assert.deepEqual(snapshot.windows.map((window) => [window.label, window.remainingPercent]), [
    ['default', 72],
    ['default', 50],
    ['a-first', 99],
    ['additional', 90],
    ['model-x', 88],
    ['z-last', 25],
  ]);
  assert.equal(snapshot.windows[0].windowDurationMins, 300);
  assert.equal(snapshot.windows[0].resetsAt, 2000000000);
  assert.equal(snapshot.fetchedAt, 1234);
});

test('availability is controlled only by default allowed', () => {
  const limited = parseUsagePayload({ ...payload(), rate_limit: { ...payload().rate_limit, allowed: false } }, 'acct-test');
  const unknown = parseUsagePayload({ ...payload(), rate_limit: { ...payload().rate_limit, allowed: 'yes' } }, 'acct-test');
  assert.equal(limited?.availability, 'limited');
  assert.equal(unknown?.availability, 'unknown');
});

test('rejects invalid windows, response accounts, and JWT scopes', () => {
  assert.equal(parseUsagePayload({ rate_limit: { primary_window: { used_percent: 101 } } }, 'acct-test'), undefined);
  assert.equal(parseUsagePayload({ ...payload('other') }, 'acct-test'), undefined);
  assert.equal(parseUsagePayload({ rate_limit: { primary_window: { used_percent: 0 }, extra: 'ignored' } }, 'acct-test')?.windows.length, 1);
  assert.equal(extractCodexAuthScope(auth()).accountId, 'acct-test');
  assert.equal(extractCodexAuthScope({ auth: { apiKey: 'not.jwt' } }), undefined);
  assert.equal(extractCodexAuthScope(auth('acct\nunsafe')), undefined);
});

test('formats permit state before window details and never guesses missing details', () => {
  const snapshot = parseUsagePayload({
    rate_limit: {
      allowed: false,
      primary_window: { used_percent: 0 },
      secondary_window: { used_percent: 100, limit_window_seconds: 60 },
    },
  }, 'acct-test', 1000);
  assert.ok(snapshot);
  assert.equal(formatUsageSnapshot(snapshot), 'Codex: limit reached · default 100% left · default 0% left (1m)');
});

test('uses the fixed URL, manual redirects, and accepts only HTTP 200', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const result = await fetchUsageSnapshot(auth(), {
    fetch: async (url, init) => {
      calls.push({ url, init: init ?? {} });
      return new Response(JSON.stringify(payload()), { status: 200, headers: { 'content-length': '20' } });
    },
  });
  assert.ok(result);
  assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal((calls[0].init.headers as Record<string, string>)['ChatGPT-Account-ID'], 'acct-test');
  assert.match((calls[0].init.headers as Record<string, string>).Authorization, /^Bearer /u);

  const redirected = await fetchUsageSnapshot(auth(), { fetch: async () => new Response('', { status: 302 }) });
  assert.equal(redirected, undefined);
});

test('rejects oversized content and response bodies without exposing response data', async () => {
  const secret = 'acct-secret-token-like-response';
  const oversized = await fetchUsageSnapshot(auth(), {
    fetch: async () => new Response(JSON.stringify({ secret, padding: 'x'.repeat(USAGE_STATUS_CONSTANTS.maxBodyBytes) }), { status: 200 }),
  });
  assert.equal(oversized, undefined);
});

test('expires the scope lease before revalidating', async () => {
  let clock = 1_000_000;
  let nextTimer = 1;
  const timers = new Map<number, { due: number; run: () => void }>();
  const statuses: Array<string | undefined> = [];
  let authCalls = 0;
  let resolveAuth: ((value: unknown) => void) | undefined;
  const context = {
    mode: 'tui',
    model: { provider: 'openai-codex', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api' },
    modelRegistry: {
      isUsingOAuth: () => true,
      getProviderAuth: () => {
        authCalls += 1;
        return new Promise((resolve) => { resolveAuth = resolve; });
      },
    },
    ui: { setStatus: (_key: string, text: string | undefined) => statuses.push(text) },
  };
  const controller = new UsageController({
    now: () => clock,
    setTimeout: (run, delay) => {
      const id = nextTimer++;
      timers.set(id, { due: clock + delay, run });
      return id as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (id) => { timers.delete(id as number); },
    fetch: async () => new Response(JSON.stringify(payload()), { status: 200 }),
  });

  controller.handle(context);
  assert.equal(authCalls, 1);
  resolveAuth?.(auth());
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(statuses.at(-1) ?? '', /^Codex: /u);

  clock += USAGE_STATUS_CONSTANTS.scopeLeaseMs;
  for (const [id, timer] of [...timers]) {
    if (timer.due <= clock) { timers.delete(id); timer.run(); }
  }
  assert.equal(statuses.at(-1), 'Codex: unavailable');
  assert.equal(authCalls, 2);
  resolveAuth?.(auth());
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(statuses.at(-1) ?? '', /^Codex: /u);

  controller.shutdown();
});

test('does not resolve auth or create timers outside TUI/provider integrity gate', () => {
  let authCalls = 0;
  let timerCalls = 0;
  const ui = { setStatus: () => {} };
  const controller = new UsageController({ setTimeout: () => { timerCalls += 1; return 1 as ReturnType<typeof setTimeout>; } });
  const context = {
    mode: 'rpc',
    model: { provider: 'openai-codex', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api' },
    modelRegistry: { isUsingOAuth: () => true, getProviderAuth: async () => { authCalls += 1; return auth(); } },
    ui,
  };
  controller.handle(context);
  assert.equal(authCalls, 0);
  assert.equal(timerCalls, 0);

  controller.handle({ ...context, mode: 'tui', model: { ...context.model, baseUrl: 'https://proxy.invalid' } });
  assert.equal(authCalls, 0);
  assert.equal(timerCalls, 0);
  controller.handle({ ...context, mode: 'tui', model: { ...context.model, api: 'openai-responses' } });
  assert.equal(authCalls, 0);
  assert.equal(timerCalls, 0);
  controller.handle({ ...context, mode: 'tui', model: context.model, modelRegistry: { ...context.modelRegistry, isUsingOAuth: () => false } });
  assert.equal(authCalls, 0);
  assert.equal(timerCalls, 0);
});
