import test from 'node:test';
import assert from 'node:assert/strict';
import extension, {
  FAST_MODEL_IDS,
  FAST_STATUS_CONSTANTS,
  FastController,
  consumeFastBootstrap,
  FAST_REQUESTED_EVENT,
  isFastEligible,
  parseFastRequestedEvent,
} from '../src/index.ts';

const FAST_ACTIVE_TEXT = '⚡ Fast';
const FAST_ACTIVE_NOTIFICATION = '⚡ Fast enabled — selected user implementer/code_reviewer agents inherit requested Fast.';
const ANSI_FAST_ACTIVE = `\u001b[38;2;217;140;63m${FAST_ACTIVE_TEXT}\u001b[0m`;
const ANSI_FAST_ACTIVE_NOTIFICATION = `\u001b[38;2;217;140;63m${FAST_ACTIVE_NOTIFICATION}\u001b[0m`;

function model(id = 'gpt-5.4', overrides: Record<string, unknown> = {}): any {
  return {
    id,
    name: id,
    provider: 'openai-codex',
    api: 'openai-codex-responses',
    baseUrl: 'https://chatgpt.com/backend-api',
    reasoning: true,
    thinkingLevelMap: {},
    cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 3 },
    ...overrides,
  };
}

function context(modelValue = model(), overrides: Record<string, unknown> = {}): any {
  const notices: Array<{ message: string; type?: string }> = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const themeCalls: Array<{ color: string; text: string }> = [];
  return {
    mode: 'tui',
    hasUI: true,
    model: modelValue,
    modelRegistry: {
      isUsingOAuth: () => true,
      getProviderAuth: async () => { throw new Error('Fast must not resolve usage auth'); },
    },
    sessionManager: {
      getSessionId: () => 'session-1',
      getSessionFile: () => '/tmp/session-1.jsonl',
    },
    ui: {
      setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
      setWidget: () => {},
      notify: (message: string, type?: string) => notices.push({ message, type }),
      theme: {
        fg: (color: string, text: string) => {
          themeCalls.push({ color, text });
          return text;
        },
      },
    },
    ...overrides,
    _notices: notices,
    _statuses: statuses,
    _themeCalls: themeCalls,
  };
}

function assistant(modelValue: any, usageOverrides: Record<string, unknown> = {}): any {
  return {
    role: 'assistant',
    provider: modelValue.provider,
    api: modelValue.api,
    model: modelValue.id,
    content: [{ type: 'text', text: 'done' }],
    usage: {
      input: 1_000_000,
      output: 2_000_000,
      cacheRead: 3_000_000,
      cacheWrite: 4_000_000,
      totalTokens: 10_000_000,
      cost: { input: 99, output: 98, cacheRead: 97, cacheWrite: 96, total: 390 },
      ...usageOverrides,
    },
    stopReason: 'stop',
    isError: false,
    timestamp: 1,
  };
}

test('eligibility is exact, allowlisted, and fail-closed when OAuth throws', () => {
  const ctx = context();
  for (const id of FAST_MODEL_IDS) assert.equal(isFastEligible(ctx, model(id)), true);
  for (const id of ['gpt-5.3-codex', 'gpt-5.4-mini', 'gpt-5.4-spark', 'GPT-5.4', 'gpt-5.40']) {
    assert.equal(isFastEligible(ctx, model(id)), false, id);
  }
  for (const overrides of [
    { provider: 'openai' },
    { api: 'openai-responses' },
    { baseUrl: 'https://proxy.example/backend-api' },
  ]) assert.equal(isFastEligible(ctx, model('gpt-5.4', overrides)), false);
  assert.equal(isFastEligible({ ...ctx, model: undefined }, undefined), false);
  assert.equal(isFastEligible({ ...ctx, modelRegistry: { isUsingOAuth: () => { throw new Error('auth'); } } }), false);
});

test('active payload replacement is direct, shallow, model-matched, and leaves invalid payloads unchanged', () => {
  const controller = new FastController();
  const ctx = context();
  controller.setRequested(true, ctx);
  const nested = { messages: [] };
  const payload = { model: 'gpt-5.4', nested, service_tier: 'default' };
  const rewritten = controller.rewriteProviderPayload(payload, ctx) as Record<string, unknown>;
  assert.notEqual(rewritten, payload);
  assert.equal(rewritten.service_tier, 'priority');
  assert.equal(rewritten.nested, nested);
  assert.equal(payload.service_tier, 'default');
  assert.equal(controller.rewriteProviderPayload({ ...payload, model: 'gpt-5.5' }, ctx), undefined);
  assert.equal(controller.rewriteProviderPayload(Object.create(null), ctx), undefined);
  assert.equal(controller.rewriteProviderPayload(null, ctx), undefined);
  assert.equal(controller.rewriteProviderPayload({ model: 'gpt-5.4' }, context(model('gpt-5.5'))), undefined);
  assert.equal(FAST_STATUS_CONSTANTS.serviceTier, 'priority');
  controller.shutdown();
});

test('commands toggle intent and status without mutating on invalid input or no-UI contexts', () => {
  const controller = new FastController();
  const ctx = context();
  controller.handleCommand('', ctx);
  assert.equal(controller.requestedOn, true);
  controller.handleCommand('status', ctx);
  controller.handleCommand('off', ctx);
  assert.equal(controller.requestedOn, false);
  controller.handleCommand('on', ctx);
  assert.equal(controller.requestedOn, true);
  controller.handleCommand('toggle', ctx);
  assert.equal(controller.requestedOn, false);
  controller.handleCommand('bad', ctx);
  assert.equal(controller.requestedOn, false);
  assert.match(ctx._notices.at(-1).message, /Usage: \/fast/u);
  const json = context(model(), { mode: 'json', hasUI: false });
  controller.handleCommand('on', json);
  assert.equal(controller.requestedOn, false);
  assert.match(json._notices.at(-1).message, /JSON\/print/u);
  const rpc = context(model(), { mode: 'rpc', hasUI: true });
  controller.handleCommand('on', rpc);
  assert.equal(controller.requestedOn, true);
  controller.handleCommand('off', rpc);
});

test('requested On remains across model switches and uses soft-orange Active plus muted Inactive/Off labels', () => {
  const controller = new FastController();
  const eligible = context(model('gpt-5.4'));
  controller.setRequested(true, eligible);
  assert.equal(controller.state, 'active');
  assert.deepEqual(eligible._statuses.at(-1), { key: FAST_STATUS_CONSTANTS.statusKey, text: ANSI_FAST_ACTIVE });
  assert.equal(eligible._notices.at(-1).message, ANSI_FAST_ACTIVE_NOTIFICATION);
  assert.equal(eligible._notices.at(-1).type, 'info');
  assert.equal(eligible._themeCalls.length, 0);

  const ineligible = context(model('gpt-5.4-mini'));
  controller.handle(ineligible, ineligible.model, true);
  assert.equal(controller.requestedOn, true);
  assert.equal(controller.state, 'inactive');
  assert.equal(ineligible._statuses.at(-1).text, 'Fast inactive');
  assert.deepEqual(ineligible._themeCalls.at(-1), { color: 'muted', text: 'Fast inactive' });
  assert.match(ineligible._notices.at(-1).message, /not eligible/u);

  controller.handle(eligible, eligible.model, true);
  assert.equal(controller.state, 'active');
  assert.equal(eligible._statuses.at(-1).text, ANSI_FAST_ACTIVE);
  assert.equal(eligible._notices.at(-1).message, ANSI_FAST_ACTIVE_NOTIFICATION);
  assert.equal(eligible._notices.at(-1).type, 'info');
  assert.equal(eligible._themeCalls.length, 0);
  controller.setRequested(false, eligible);
  assert.equal(controller.state, 'off');
  assert.equal(eligible._statuses.at(-1).text, 'Fast off');
  assert.deepEqual(eligible._themeCalls.at(-1), { color: 'muted', text: 'Fast off' });
  controller.shutdown();
  assert.equal(controller.requestedOn, false);
  assert.equal(eligible._statuses.at(-1).text, undefined);
});

test('RPC activation notification stays plain and uses info type', () => {
  const controller = new FastController();
  const rpc = context(model('gpt-5.4'), { mode: 'rpc', hasUI: true });
  controller.setRequested(true, rpc);
  assert.equal(rpc._notices.at(-1).message, FAST_ACTIVE_NOTIFICATION);
  assert.equal(rpc._notices.at(-1).type, 'info');
  assert.equal(rpc._notices.at(-1).message.includes('\u001b'), false);
  controller.shutdown();
});

test('ticket uses rewrite-time model/session, survives mid-stream off, and corrects exact priority cost', () => {
  const controller = new FastController();
  const ctx = context(model('gpt-5.4'));
  controller.setRequested(true, ctx);
  assert.ok(controller.rewriteProviderPayload({ model: 'gpt-5.4', input: [] }, ctx));
  controller.setRequested(false, ctx);
  const message = assistant(ctx.model);
  const result = controller.rewriteAssistantMessage(message, ctx);
  assert.ok(result);
  assert.deepEqual(result.message.usage.cost, {
    input: 2,
    output: 8,
    cacheRead: 3,
    cacheWrite: 24,
    total: 37,
  });
  assert.equal(result.message.content, message.content);
  assert.equal(result.message.stopReason, message.stopReason);
  controller.shutdown();
});

test('gpt-5.5 uses native floating pricing order and is idempotent', () => {
  const controller = new FastController();
  const ctx = context(model('gpt-5.5', {
    contextWindow: 272_000,
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  }));
  const usage = {
    input: 123_457,
    output: 234_569,
    cacheRead: 345_679,
    cacheWrite: 0,
    totalTokens: 703_705,
  };
  controller.setRequested(true, ctx);
  controller.rewriteProviderPayload({ model: 'gpt-5.5' }, ctx);
  const first = controller.rewriteAssistantMessage(assistant(ctx.model, usage), ctx);
  assert.ok(first);
  const firstCost = first.message.usage.cost;
  assert.equal(firstCost.total, firstCost.input + firstCost.output + firstCost.cacheRead + firstCost.cacheWrite);
  assert.notEqual(firstCost.input, Math.round(firstCost.input));

  controller.rewriteProviderPayload({ model: 'gpt-5.5' }, ctx);
  const alreadyNativePriority = assistant(ctx.model, { ...usage, cost: firstCost });
  assert.equal(controller.rewriteAssistantMessage(alreadyNativePriority, ctx), undefined);
  controller.shutdown();
});

test('long-context pricing selects the native model tier before applying Fast multiplier', () => {
  const controller = new FastController();
  const ctx = context(model('gpt-5.4', {
    contextWindow: 272_000,
    cost: {
      input: 2.5,
      output: 15,
      cacheRead: 0.25,
      cacheWrite: 0,
      tiers: [{ inputTokensAbove: 272_000, input: 5, output: 22.5, cacheRead: 0.5, cacheWrite: 0 }],
    },
  }));
  controller.setRequested(true, ctx);
  controller.rewriteProviderPayload({ model: 'gpt-5.4' }, ctx);
  const corrected = controller.rewriteAssistantMessage(assistant(ctx.model, {
    input: 300_001,
    output: 7,
    cacheRead: 1_000,
    cacheWrite: 0,
    totalTokens: 301_008,
  }), ctx);
  assert.ok(corrected);
  assert.deepEqual(corrected.message.usage.cost, {
    input: 3.00001,
    output: 0.000315,
    cacheRead: 0.001,
    cacheWrite: 0,
    total: 3.001325,
  });
  controller.shutdown();
});

test('rejects malformed usage and corrects valid error or aborted usage', () => {
  const controller = new FastController();
  const ctx = context(model('gpt-5.4'));
  controller.setRequested(true, ctx);
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) {
    controller.rewriteProviderPayload({ model: 'gpt-5.4' }, ctx);
    assert.equal(controller.rewriteAssistantMessage(assistant(ctx.model, { [field]: -1 }), ctx), undefined);
    controller.rewriteProviderPayload({ model: 'gpt-5.4' }, ctx);
    assert.equal(controller.rewriteAssistantMessage(assistant(ctx.model, { [field]: 1.5 }), ctx), undefined);
  }
  for (const overrides of [
    { reasoning: -1 },
    { reasoning: 1.5 },
    { reasoning: 2_000_001 },
    { cacheWrite1h: -1 },
    { cacheWrite1h: 1.5 },
    { cacheWrite1h: 4_000_001 },
  ]) {
    controller.rewriteProviderPayload({ model: 'gpt-5.4' }, ctx);
    assert.equal(controller.rewriteAssistantMessage(assistant(ctx.model, overrides), ctx), undefined);
  }
  controller.rewriteProviderPayload({ model: 'gpt-5.4' }, ctx);
  const partial = assistant(ctx.model);
  partial.usage = { ...partial.usage, cacheRead: undefined };
  assert.equal(controller.rewriteAssistantMessage(partial, ctx), undefined);

  for (const [stopReason, isError] of [['error', true], ['aborted', false]] as const) {
    controller.rewriteProviderPayload({ model: 'gpt-5.4' }, ctx);
    const message = assistant(ctx.model);
    message.stopReason = stopReason;
    message.isError = isError;
    assert.ok(controller.rewriteAssistantMessage(message, ctx));
  }
  controller.shutdown();
});

test('a new extension factory starts Fast Off even after another instance was turned On', async () => {
  const makeHarness = () => {
    const handlers = new Map<string, Function>();
    const emitted: Array<{ name: string; data: unknown }> = [];
    let command: ((args: string, ctx: any) => Promise<void>) | undefined;
    extension({
      on: (name: string, handler: Function) => handlers.set(name, handler),
      events: {
        emit: (name: string, data: unknown) => emitted.push({ name, data }),
        on: () => () => {},
      },
      registerCommand: (_name: string, options: { handler: typeof command }) => { command = options.handler; },
    } as any);
    return { handlers, command, emitted };
  };
  const first = makeHarness();
  const firstContext = context();
  await first.command?.('on', firstContext);
  assert.equal(firstContext._statuses.at(-1)?.text, ANSI_FAST_ACTIVE);

  const second = makeHarness();
  const secondContext = context();
  second.handlers.get('session_start')?.({}, secondContext);
  assert.equal(secondContext._statuses.findLast((status) => status.key === FAST_STATUS_CONSTANTS.statusKey)?.text, 'Fast off');
});

test('bootstrap Fast env is exact, one-shot, and deleted for every value', () => {
  const previous = process.env.PI_CODEX_FAST;
  try {
    for (const [value, expected] of [['1', true], [undefined, false], ['true', false], ['01', false], [' 1', false], ['1 ', false], [' 1 ', false]] as const) {
      if (value === undefined) delete process.env.PI_CODEX_FAST;
      else process.env.PI_CODEX_FAST = value;
      assert.equal(consumeFastBootstrap(), expected, value ?? 'missing');
      assert.equal(process.env.PI_CODEX_FAST, undefined);
    }
  } finally {
    if (previous === undefined) delete process.env.PI_CODEX_FAST;
    else process.env.PI_CODEX_FAST = previous;
  }
});

test('interop payload is strict and extension publishes session-scoped intent at lifecycle boundaries', async () => {
  const previous = process.env.PI_CODEX_FAST;
  delete process.env.PI_CODEX_FAST;
  try {
    const handlers = new Map<string, Function>();
    const emitted: Array<{ name: string; data: unknown }> = [];
    let command: ((args: string, ctx: any) => Promise<void>) | undefined;
    extension({
      on: (name: string, handler: Function) => handlers.set(name, handler),
      events: { emit: (name: string, data: unknown) => emitted.push({ name, data }), on: () => () => {} },
      registerCommand: (_name: string, options: { handler: typeof command }) => { command = options.handler; },
    } as any);
    const ctx = context();
    handlers.get('session_start')?.({}, ctx);
    assert.deepEqual(emitted.at(-1), {
      name: FAST_REQUESTED_EVENT,
      data: { version: 1, sessionId: 'session-1', requested: false },
    });
    await command?.('status', ctx);
    await command?.('bad', ctx);
    assert.equal(emitted.length, 1);
    await command?.('on', ctx);
    assert.deepEqual(emitted.at(-1)?.data, { version: 1, sessionId: 'session-1', requested: true });
    await command?.('on', ctx);
    assert.equal(emitted.length, 2);
    const json = context(model(), { mode: 'json', hasUI: false });
    await command?.('off', json);
    assert.equal(emitted.length, 2);
    handlers.get('session_shutdown')?.({}, ctx);
    assert.deepEqual(emitted.at(-1)?.data, { version: 1, sessionId: 'session-1', requested: false });

    const valid = { version: 1, sessionId: 's', requested: true };
    assert.deepEqual(parseFastRequestedEvent(valid), valid);
    for (const malformed of [
      null,
      [],
      { ...valid, extra: true },
      { ...valid, version: '1' },
      { ...valid, sessionId: '' },
      { ...valid, requested: 1 },
    ]) assert.equal(parseFastRequestedEvent(malformed), undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_CODEX_FAST;
    else process.env.PI_CODEX_FAST = previous;
  }
});

test('inherited JSON child starts requested On without a command, and a second factory is Off', () => {
  const previous = process.env.PI_CODEX_FAST;
  try {
    process.env.PI_CODEX_FAST = '1';
    const makeHarness = () => {
      const handlers = new Map<string, Function>();
      const emitted: unknown[] = [];
      extension({
        on: (name: string, handler: Function) => handlers.set(name, handler),
        events: { emit: (_name: string, data: unknown) => emitted.push(data), on: () => () => {} },
        registerCommand: () => {},
      } as any);
      return { handlers, emitted };
    };
    const first = makeHarness();
    assert.equal(process.env.PI_CODEX_FAST, undefined);
    const firstContext = context(model('gpt-5.4'), { mode: 'json', hasUI: false });
    first.handlers.get('session_start')?.({}, firstContext);
    assert.equal(firstContext._statuses.at(-1)?.text, ANSI_FAST_ACTIVE);
    const inheritedPayload = { model: 'gpt-5.4', service_tier: 'default' };
    const inheritedResult = first.handlers.get('before_provider_request')?.({ payload: inheritedPayload }, firstContext);
    assert.equal(inheritedResult?.service_tier, 'priority');
    assert.equal(inheritedPayload.service_tier, 'default');

    const ineligibleContext = context(model('gpt-5.4-mini'), { mode: 'json', hasUI: false });
    const ineligiblePayload = { model: 'gpt-5.4-mini', service_tier: 'default' };
    assert.equal(first.handlers.get('before_provider_request')?.({ payload: ineligiblePayload }, ineligibleContext), undefined);
    assert.deepEqual(ineligiblePayload, { model: 'gpt-5.4-mini', service_tier: 'default' });

    const second = makeHarness();
    const secondContext = context(model('gpt-5.4'), { mode: 'json', hasUI: false });
    second.handlers.get('session_start')?.({}, secondContext);
    assert.equal(secondContext._statuses.at(-1)?.text, 'Fast off');
    assert.equal(second.handlers.get('before_provider_request')?.({ payload: { model: 'gpt-5.4' } }, secondContext), undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_CODEX_FAST;
    else process.env.PI_CODEX_FAST = previous;
  }
});

test('mismatched and malformed assistant messages fail open, and shutdown clears tickets', () => {
  const controller = new FastController();
  const ctx = context(model('gpt-5.4'));
  controller.setRequested(true, ctx);
  controller.rewriteProviderPayload({ model: 'gpt-5.4' }, ctx);
  assert.equal(controller.rewriteAssistantMessage({ role: 'assistant', provider: 'other', api: ctx.model.api, model: ctx.model.id, usage: {} }, ctx), undefined);
  controller.rewriteProviderPayload({ model: 'gpt-5.4' }, ctx);
  assert.equal(controller.rewriteAssistantMessage({ role: 'assistant', provider: ctx.model.provider, api: ctx.model.api, model: ctx.model.id, usage: {} }, ctx), undefined);
  controller.rewriteProviderPayload({ model: 'gpt-5.4' }, ctx);
  const otherSession = context(ctx.model, {
    sessionManager: {
      getSessionId: () => 'session-2',
      getSessionFile: () => '/tmp/session-2.jsonl',
    },
  });
  assert.equal(controller.rewriteAssistantMessage(assistant(ctx.model), otherSession), undefined);
  controller.rewriteProviderPayload({ model: 'gpt-5.4' }, ctx);
  controller.shutdown();
  assert.equal(controller.rewriteAssistantMessage(assistant(ctx.model), ctx), undefined);
});

test('ticket queue is bounded and drops the oldest request-time ticket', () => {
  const controller = new FastController();
  const firstContext = context(model('gpt-5.4'));
  const laterContext = context(model('gpt-5.5'));
  controller.setRequested(true, firstContext);
  controller.rewriteProviderPayload({ model: 'gpt-5.4' }, firstContext);
  for (let i = 0; i < FAST_STATUS_CONSTANTS.maxPendingTickets; i += 1) {
    controller.rewriteProviderPayload({ model: 'gpt-5.5' }, laterContext);
  }

  // The first gpt-5.4 ticket was evicted; the remaining tickets are gpt-5.5.
  assert.equal(controller.rewriteAssistantMessage(assistant(firstContext.model), firstContext), undefined);
  const corrected = controller.rewriteAssistantMessage(assistant(laterContext.model), laterContext);
  assert.ok(corrected);
  controller.shutdown();
});

test('Fast wiring registers command and provider/message hooks without usage auth or timers', async () => {
  const handlers = new Map<string, Function>();
  let command: ((args: string, ctx: any) => Promise<void>) | undefined;
  const api: any = {
    on: (name: string, handler: Function) => handlers.set(name, handler),
    events: { emit: () => {}, on: () => () => {} },
    registerCommand: (_name: string, options: { handler: typeof command }) => { command = options.handler; },
  };
  extension(api);
  assert.ok(command);
  assert.ok(handlers.has('before_provider_request'));
  assert.ok(handlers.has('message_end'));
  const ctx = context();
  let authCalls = 0;
  ctx.modelRegistry.getProviderAuth = async () => { authCalls += 1; return undefined; };
  await command?.('on', ctx);
  const rewritten = handlers.get('before_provider_request')?.({ payload: { model: ctx.model.id } }, ctx);
  assert.equal((rewritten as any).service_tier, 'priority');
  assert.equal(authCalls, 0);
  handlers.get('session_shutdown')?.({}, ctx);
  assert.equal((await handlers.get('message_end')?.({ message: assistant(ctx.model) }, ctx)), undefined);
});
