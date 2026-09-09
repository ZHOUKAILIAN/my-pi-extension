import test from 'node:test';
import assert from 'node:assert/strict';
import * as publicEntry from '../src/index.ts';
import {
  UsageController,
  USAGE_STATUS_CONSTANTS,
  fetchUsageSnapshot,
  formatProgressBar,
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
      { limit_name: 'GPT-5.3-Codex-Spark', rate_limit: { primary_window: { used_percent: 5 } } },
      { limit_name: '\u001b[31mbad', rate_limit: { primary_window: { used_percent: 10 } } },
      { metered_feature: 'model-x', rate_limit: { primary_window: { used_percent: 12, reset_at: 2000000200 } } },
      { limit_name: 'z-last', rate_limit: { primary_window: { used_percent: 75 } } },
      { limit_name: 'a-first', rate_limit: { primary_window: { used_percent: 1 } } },
    ],
  };
}

test('public entry does not expose auth scope extraction or account scope types', () => {
  assert.equal('extractCodexAuthScope' in publicEntry, false);
  assert.equal('CodexAuthScope' in publicEntry, false);
  assert.equal('InternalScopedSnapshot' in publicEntry, false);
});

test('projects only primary and secondary windows from the default rate limit', () => {
  const snapshot = parseUsagePayload(payload(), 'acct-test', 1234);
  assert.ok(snapshot);
  assert.equal(snapshot.availability, 'allowed');
  assert.deepEqual(snapshot.windows.map((window) => window.remainingPercent), [72, 50]);
  assert.equal('label' in snapshot.windows[0], false);
  assert.equal(snapshot.windows[0].windowDurationMins, 300);
  assert.equal(snapshot.windows[0].resetsAt, 2000000000);
  assert.equal(snapshot.fetchedAt, 1234);
  assert.doesNotMatch(formatUsageSnapshot(snapshot), /GPT-5\.3-Codex-Spark|model-x|a-first|z-last/u);
});

test('availability is controlled only by default allowed', () => {
  const limited = parseUsagePayload({ ...payload(), rate_limit: { ...payload().rate_limit, allowed: false } }, 'acct-test');
  const unknown = parseUsagePayload({ ...payload(), rate_limit: { ...payload().rate_limit, allowed: 'yes' } }, 'acct-test');
  assert.equal(limited?.availability, 'limited');
  assert.equal(unknown?.availability, 'unknown');
});

test('rejects invalid windows, response accounts, and JWT scopes', async () => {
  assert.equal(parseUsagePayload({ rate_limit: { primary_window: { used_percent: 101 } } }, 'acct-test'), undefined);
  assert.equal(parseUsagePayload({ ...payload('other') }, 'acct-test'), undefined);
  assert.equal(parseUsagePayload({ rate_limit: { primary_window: { used_percent: 0 }, extra: 'ignored' } }, 'acct-test')?.windows.length, 1);
  assert.equal(await fetchUsageSnapshot(auth('acct\nunsafe'), { fetch: async () => { throw new Error('must not fetch'); } }), undefined);
  assert.equal(await fetchUsageSnapshot({ auth: { apiKey: 'not.jwt' } }, { fetch: async () => { throw new Error('must not fetch'); } }), undefined);
});

test('formats availability, progress, and reset details without a default label', () => {
  assert.equal(formatProgressBar(0), '░░░░░░░░░░');
  assert.equal(formatProgressBar(49), '█████░░░░░');
  assert.equal(formatProgressBar(98), '██████████');
  assert.equal(formatProgressBar(100), '██████████');

  const allowed = parseUsagePayload({
    rate_limit: {
      allowed: true,
      primary_window: { used_percent: 2, limit_window_seconds: 18000, reset_at: 2000000000 },
    },
  }, 'acct-test', 1000);
  assert.ok(allowed);
  const reset = new Date(2000000000 * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][reset.getMonth()];
  assert.equal(formatUsageSnapshot(allowed), `Codex · 98% ██████████ · ${month} ${reset.getDate()} ${pad(reset.getHours())}:${pad(reset.getMinutes())}`);

  const limited = parseUsagePayload({
    rate_limit: {
      allowed: false,
      primary_window: { used_percent: 0 },
      secondary_window: { used_percent: 100, limit_window_seconds: 60 },
    },
  }, 'acct-test', 1000);
  assert.ok(limited);
  assert.equal(formatUsageSnapshot(limited), 'Codex limit reached');

  const unknown = parseUsagePayload({
    rate_limit: { primary_window: { used_percent: 50 } },
  }, 'acct-test', 1000);
  assert.ok(unknown);
  assert.equal(formatUsageSnapshot(unknown), 'Codex status unknown · 50% █████░░░░░');
});

test('marks a same-scope failed refresh stale without additional windows', async () => {
  let clock = 1_000_000;
  let fetchCalls = 0;
  const statuses: Array<string | undefined> = [];
  const context = {
    mode: 'tui',
    model: { provider: 'openai-codex', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api' },
    modelRegistry: {
      isUsingOAuth: () => true,
      getProviderAuth: async () => auth(),
    },
    ui: { setStatus: (_key: string, text: string | undefined) => statuses.push(text) },
  };
  const controller = new UsageController({
    now: () => clock,
    fetch: async () => {
      fetchCalls += 1;
      if (fetchCalls > 1) throw new Error('temporary failure');
      return new Response(JSON.stringify(payload()), { status: 200 });
    },
  });

  try {
    controller.handle(context);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(statuses.at(-1) ?? '', /^Codex · 72% ███████░░░ · /u);

    // The scope lease and usage interval are both one minute. Move only the
    // usage attempt clock so this test stays within the active scope lease.
    (controller as unknown as { lastUsageAttempt: number }).lastUsageAttempt = clock - USAGE_STATUS_CONSTANTS.usageMinIntervalMs;
    controller.handle(context);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(statuses.at(-1) ?? '', /^Codex: stale · 72% ███████░░░ · /u);
    assert.doesNotMatch(statuses.at(-1) ?? '', /model-x|a-first|z-last|5h|7d|left|resets|\[/u);
  } finally {
    controller.shutdown();
  }
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
  assert.match(statuses.at(-1) ?? '', /^Codex(?: |:)/u);

  clock += USAGE_STATUS_CONSTANTS.scopeLeaseMs;
  for (const [id, timer] of [...timers]) {
    if (timer.due <= clock) { timers.delete(id); timer.run(); }
  }
  assert.equal(statuses.at(-1), 'Codex: unavailable');
  assert.equal(authCalls, 2);
  resolveAuth?.(auth());
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(statuses.at(-1) ?? '', /^Codex(?: |:)/u);

  controller.shutdown();
});

test('model_select clears a same-provider snapshot before revalidation', async () => {
  let secondAuthResolve: ((value: unknown) => void) | undefined;
  let authCalls = 0;
  const statuses: Array<string | undefined> = [];
  const context = {
    mode: 'tui',
    model: { provider: 'openai-codex', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api' },
    modelRegistry: {
      isUsingOAuth: () => true,
      getProviderAuth: () => {
        authCalls += 1;
        if (authCalls === 1) return Promise.resolve(auth());
        return new Promise((resolve) => { secondAuthResolve = resolve; });
      },
    },
    ui: { setStatus: (_key: string, text: string | undefined) => statuses.push(text) },
  };
  const controller = new UsageController({
    fetch: async () => new Response(JSON.stringify(payload()), { status: 200 }),
  });

  controller.handle(context);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(statuses.at(-1) ?? '', /^Codex(?: |:)/u);

  controller.handle(context, context.model, true);
  assert.equal(statuses.at(-1), 'Codex: unavailable');
  assert.equal(authCalls, 2);
  secondAuthResolve?.(auth());
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(statuses.at(-1) ?? '', /^Codex(?: |:)/u);
  controller.shutdown();
});

test('replays a pending scope refresh after leaving and returning while auth is in flight', async () => {
  const resolvers: Array<(value: unknown) => void> = [];
  let authCalls = 0;
  const statuses: Array<string | undefined> = [];
  const codexModel = { provider: 'openai-codex', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api' };
  const context = {
    mode: 'tui',
    model: codexModel,
    modelRegistry: {
      isUsingOAuth: () => true,
      getProviderAuth: () => {
        authCalls += 1;
        return new Promise((resolve) => { resolvers.push(resolve); });
      },
    },
    ui: { setStatus: (_key: string, text: string | undefined) => statuses.push(text) },
  };
  const controller = new UsageController({
    fetch: async () => new Response(JSON.stringify(payload()), { status: 200 }),
  });

  controller.handle(context);
  controller.handle({ ...context, model: { ...codexModel, provider: 'other' } }, { ...codexModel, provider: 'other' }, true);
  controller.handle(context, codexModel, true);
  assert.equal(authCalls, 1);
  resolvers[0](auth());
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(authCalls, 2);
  resolvers[1](auth());
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(statuses.at(-1) ?? '', /^Codex(?: |:)/u);
  controller.shutdown();
});

test('drops stale pending scope refreshes when leaving Codex before auth settles', async () => {
  const resolvers: Array<(value: unknown) => void> = [];
  let authCalls = 0;
  const statuses: Array<string | undefined> = [];
  const codexModel = { provider: 'openai-codex', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api' };
  const context = {
    mode: 'tui',
    model: codexModel,
    modelRegistry: {
      isUsingOAuth: () => true,
      getProviderAuth: () => {
        authCalls += 1;
        return new Promise((resolve) => { resolvers.push(resolve); });
      },
    },
    ui: { setStatus: (_key: string, text: string | undefined) => statuses.push(text) },
  };
  const otherModel = { ...codexModel, provider: 'other' };
  const otherContext = { ...context, model: otherModel };
  const controller = new UsageController({
    fetch: async () => new Response(JSON.stringify(payload()), { status: 200 }),
  });

  controller.handle(context);
  controller.handle(context, codexModel, true);
  controller.handle(otherContext, otherModel, true);
  assert.equal(authCalls, 1);

  resolvers[0](auth());
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(authCalls, 1);

  controller.handle(context, codexModel, true);
  assert.equal(authCalls, 2);
  resolvers[1](auth());
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(authCalls, 2);
  assert.match(statuses.at(-1) ?? '', /^Codex(?: |:)/u);
  controller.shutdown();
});

test('replays a pending usage refresh after a model generation changes during fetch', async () => {
  let resolveFirstFetch: ((response: Response) => void) | undefined;
  let fetchCalls = 0;
  const statuses: Array<string | undefined> = [];
  const context = {
    mode: 'tui',
    model: { provider: 'openai-codex', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api' },
    modelRegistry: {
      isUsingOAuth: () => true,
      getProviderAuth: async () => auth(),
    },
    ui: { setStatus: (_key: string, text: string | undefined) => statuses.push(text) },
  };
  const controller = new UsageController({
    fetch: async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) return new Promise((resolve) => { resolveFirstFetch = resolve; });
      return new Response(JSON.stringify(payload()), { status: 200 });
    },
  });

  controller.handle(context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls, 1);
  controller.handle(context, context.model, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(statuses.at(-1), 'Codex: unavailable');
  resolveFirstFetch?.(new Response(JSON.stringify(payload()), { status: 200 }));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls, 2);
  assert.match(statuses.at(-1) ?? '', /^Codex(?: |:)/u);
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
