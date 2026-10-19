import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMachinePreference, writeMachinePreference } from '../src/machine-settings.ts';
const readPreference = async (root: string, _name: string) => { const result = await readMachinePreference('fast', `${root}/settings.json`); return { snapshot: { enabled: result.value ?? false } }; };
import extension, {
  FAST_COST_CORRECTION_MODEL_IDS,
  FAST_STATUS_CONSTANTS,
  FastController,
  formatFastDisplay,
  consumeFastBootstrap,
  isFastEligible,
  parseFastRequestedEvent,
} from '../src/index.ts';

// All extension-command harnesses in this file use a disposable Pi agent directory.
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let suiteAgentDir: string;
before(() => {
  suiteAgentDir = mkdtempSync(join(realpathSync(tmpdir()), 'fast-mode-agent-'));
  process.env.PI_CODING_AGENT_DIR = suiteAgentDir;
});
beforeEach(() => { process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(suiteAgentDir, 'prefs-')); });
after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await new Promise(resolve => setTimeout(resolve, 100));
  await rm(suiteAgentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function isolatedEvents(t: { after(fn: () => void): void }): string {
  const prior = process.env.PI_CODING_AGENT_DIR;
  const root = mkdtempSync(join(suiteAgentDir, 'case-'));
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => { if (prior !== undefined) process.env.PI_CODING_AGENT_DIR = prior; });
  return join(root, 'metrics', 'codex-fast-enabled', 'v1');
}

async function eventRecords(path: string): Promise<Array<{ name: string; record: any }>> {
  let names: string[];
  try { names = await readdir(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return Promise.all(names.filter(name => name.endsWith('.json')).map(async (name) => ({ name, record: JSON.parse(await readFile(join(path, name), 'utf8')) })));
}
async function waitForEvents(path: string, count: number) {
  const until = Date.now() + 1200;
  for (;;) {
    const records = await eventRecords(path);
    if (records.length === count) return records;
    if (Date.now() >= until) throw new Error(`expected ${count} completed Fast records, found ${records.length}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function waitForNotice(ctx: any) {
  const until = Date.now() + 1200;
  while (ctx._notices.at(-1)?.message !== '本次计量记录无法确认') {
    if (Date.now() >= until) throw new Error('background warning missing');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function commandHarness(emit: (name: string, data: unknown) => void = () => {}, dependencies: Parameters<typeof extension>[1] = {}): {
  handlers: Map<string, Function>;
  command: (args: string, ctx: any) => Promise<void>;
} {
  const handlers = new Map<string, Function>();
  let command: ((args: string, ctx: any) => Promise<void>) | undefined;
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? mkdtempSync(join(suiteAgentDir, 'command-prefs-'));
  try {
    extension({
    on: (name: string, handler: Function) => handlers.set(name, handler),
    events: { emit, on: () => () => {} },
    registerCommand: (_name: string, options: { handler: typeof command }) => { command = options.handler; },
  } as any, { ...dependencies, settingsFile: join(agentDir, 'settings.json') });
  } finally {}
  assert.ok(command);
  return { handlers, command };
}

function sharedMachineHarness(agentDir: string, dependencies: Parameters<typeof extension>[1] = {}) {
  const handlers = new Map<string, Function>();
  let command: ((args: string, ctx: any) => Promise<void>) | undefined;
  const emitted: unknown[] = [];
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    extension({
      on: (name: string, handler: Function) => handlers.set(name, handler),
      events: { emit: (_name: string, value: unknown) => emitted.push(value), on: () => () => {} },
      registerCommand: (_name: string, value: { handler: typeof command }) => { command = value.handler; },
    } as any, { ...dependencies, settingsFile: join(agentDir, 'settings.json') });
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
  return { handlers, command: command!, emitted };
}

const FAST_ACTIVE_TEXT = '⚡ Fast';
const FAST_ACTIVE_NOTIFICATION = '⚡ Fast enabled — all Pi agents use the machine Fast preference.';
const FAST_UNKNOWN_ACTIVE_NOTIFICATION = '⚡ Fast enabled — all Pi agents use the machine Fast preference; priority is request intent only; usage cost is not corrected or guaranteed.';
const ANSI_FAST_ACTIVE = `\u001b[38;2;217;140;63m${FAST_ACTIVE_TEXT}\u001b[0m`;
const ANSI_FAST_ACTIVE_NOTIFICATION = `\u001b[38;2;217;140;63m${FAST_ACTIVE_NOTIFICATION}\u001b[0m`;
const ANSI_FAST_UNKNOWN_ACTIVE_NOTIFICATION = `\u001b[38;2;217;140;63m${FAST_UNKNOWN_ACTIVE_NOTIFICATION}\u001b[0m`;

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

test('eligibility accepts all valid lowercase gpt IDs while cost correction IDs remain a separate set', () => {
  const ctx = context();
  assert.deepEqual([...FAST_COST_CORRECTION_MODEL_IDS], ['gpt-5.4', 'gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra']);
  for (const id of [...FAST_COST_CORRECTION_MODEL_IDS, 'gpt-5.4-astra', 'gpt-5.4-mini', 'gpt-5.4-spark', 'gpt-future-2027']) {
    assert.equal(isFastEligible(ctx, model(id)), true, id);
  }
  for (const id of ['gpt-', 'GPT-5.4', 'gpt -5.4', 'gpt-5.4 mini', 'gpt-5.4\tmini', 'codex-5.4']) {
    assert.equal(isFastEligible(ctx, model(id)), false, id);
  }
  for (const overrides of [
    { provider: 'openai' },
    { api: 'openai-responses' },
    { baseUrl: 'https://proxy.example/backend-api' },
  ]) assert.equal(isFastEligible(ctx, model('gpt-future-2027', overrides)), false);
  assert.equal(isFastEligible({ ...ctx, model: undefined }, undefined), false);
  assert.equal(isFastEligible({ ...ctx, modelRegistry: { isUsingOAuth: () => false } }), false);
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

test('unknown active/status/model switches explain priority intent and uncorrected cost', () => {
  const controller = new FastController();
  const unknown = context(model('gpt-5.4-astra'));
  controller.setRequested(true, unknown);
  assert.equal(unknown._notices.at(-1).message, ANSI_FAST_UNKNOWN_ACTIVE_NOTIFICATION);
  assert.match(unknown._notices.at(-1).message, /all Pi agents use the machine Fast preference/u);
  assert.match(unknown._notices.at(-1).message, /priority is request intent only/u);
  assert.match(unknown._notices.at(-1).message, /usage cost is not corrected or guaranteed/u);

  const unknownRpc = context(model('gpt-5.4-astra'), { mode: 'rpc', hasUI: true });
  controller.handle(unknownRpc, unknownRpc.model, true);
  assert.equal(unknownRpc._notices.at(-1).message, FAST_UNKNOWN_ACTIVE_NOTIFICATION);
  assert.equal(unknownRpc._notices.at(-1).message.includes('\u001b'), false);

  assert.match(unknown._notices.at(-1).message, /priority is request intent only/u);
  const unknownAgain = context(model('gpt-future-2027'));
  controller.handle(unknownAgain, unknownAgain.model, true);
  assert.match(unknownAgain._notices.at(-1).message, /usage cost is not corrected or guaranteed/u);

  const known = context(model('gpt-5.4'));
  controller.handle(known, known.model, true);
  assert.equal(known._notices.at(-1).message, ANSI_FAST_ACTIVE_NOTIFICATION);
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
  assert.equal(controller.requestedOn, true);
  controller.handleCommand('bad', ctx);
  assert.equal(controller.requestedOn, true);
  assert.match(ctx._notices.at(-1).message, /Usage: \/fast/u);
  const json = context(model(), { mode: 'json', hasUI: false });
  controller.handleCommand('on', json);
  assert.equal(controller.requestedOn, true);
  assert.match(json._notices.at(-1).message, /without a UI/u);
  const rpc = context(model(), { mode: 'rpc', hasUI: true });
  controller.handleCommand('on', rpc);
  assert.equal(controller.requestedOn, true);
  controller.handleCommand('off', rpc);
});

test('requested On remains across model switches and uses soft-orange Active plus muted Inactive/Off labels', () => {
  const controller = new FastController();
  const displayChanges: string[] = [];
  controller.onDisplayStateChange((snapshot) => displayChanges.push(snapshot.state));
  const eligible = context(model('gpt-5.4'));
  controller.setRequested(true, eligible);
  assert.equal(controller.state, 'active');
  assert.equal(formatFastDisplay(controller.getDisplaySnapshot(), eligible.ui.theme), ANSI_FAST_ACTIVE);
  assert.equal(eligible._statuses.length, 0);
  assert.equal(eligible._notices.at(-1).message, ANSI_FAST_ACTIVE_NOTIFICATION);
  assert.equal(eligible._notices.at(-1).type, 'info');
  assert.equal(eligible._themeCalls.length, 0);

  const ineligible = context(model('gpt-'));
  controller.handle(ineligible, ineligible.model, true);
  assert.equal(controller.requestedOn, true);
  assert.equal(controller.state, 'inactive');
  assert.equal(formatFastDisplay(controller.getDisplaySnapshot(), ineligible.ui.theme), 'Fast inactive');
  assert.equal(ineligible._statuses.length, 0);
  assert.match(ineligible._notices.at(-1).message, /not eligible/u);

  controller.handle(eligible, eligible.model, true);
  assert.equal(controller.state, 'active');
  assert.equal(formatFastDisplay(controller.getDisplaySnapshot(), eligible.ui.theme), ANSI_FAST_ACTIVE);
  assert.equal(eligible._statuses.length, 0);
  assert.equal(eligible._notices.at(-1).message, ANSI_FAST_ACTIVE_NOTIFICATION);
  assert.equal(eligible._notices.at(-1).type, 'info');
  assert.equal(eligible._themeCalls.length, 0);
  controller.setRequested(false, eligible);
  assert.equal(controller.state, 'off');
  assert.deepEqual(displayChanges, ['active', 'inactive', 'active', 'off']);
  assert.equal(formatFastDisplay(controller.getDisplaySnapshot(), eligible.ui.theme), 'Fast off');
  assert.equal(eligible._statuses.length, 0);
  controller.shutdown();
  assert.equal(controller.requestedOn, false);
  assert.equal(eligible._statuses.length, 0);
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

test('known and unknown tickets stay FIFO-isolated and unknown cost remains unchanged', () => {
  const controller = new FastController();
  const known = context(model('gpt-5.4'));
  const unknown = context(model('gpt-5.4-spark'));
  controller.setRequested(true, known);

  controller.rewriteProviderPayload({ model: known.model.id }, known);
  const unknownPayload = controller.rewriteProviderPayload({ model: unknown.model.id }, unknown) as Record<string, unknown>;
  assert.equal(unknownPayload.service_tier, 'priority');
  controller.rewriteProviderPayload({ model: known.model.id }, known);

  const knownFirst = controller.rewriteAssistantMessage(assistant(known.model), known);
  assert.ok(knownFirst);
  assert.deepEqual(knownFirst.message.usage.cost, {
    input: 2,
    output: 8,
    cacheRead: 3,
    cacheWrite: 24,
    total: 37,
  });

  const unknownMessage = assistant(unknown.model);
  const unknownCost = { ...unknownMessage.usage.cost };
  assert.equal(controller.rewriteAssistantMessage(unknownMessage, unknown), undefined);
  assert.deepEqual(unknownMessage.usage.cost, unknownCost);

  const knownSecond = controller.rewriteAssistantMessage(assistant(known.model), known);
  assert.ok(knownSecond);
  assert.deepEqual(knownSecond.message.usage.cost, {
    input: 2,
    output: 8,
    cacheRead: 3,
    cacheWrite: 24,
    total: 37,
  });

  controller.rewriteProviderPayload({ model: unknown.model.id }, unknown);
  controller.rewriteProviderPayload({ model: known.model.id }, known);
  controller.rewriteProviderPayload({ model: unknown.model.id }, unknown);
  const unknownFirstAgain = assistant(unknown.model);
  assert.equal(controller.rewriteAssistantMessage(unknownFirstAgain, unknown), undefined);
  assert.deepEqual(unknownFirstAgain.usage.cost, unknownCost);
  assert.ok(controller.rewriteAssistantMessage(assistant(known.model), known));
  const unknownLastAgain = assistant(unknown.model);
  assert.equal(controller.rewriteAssistantMessage(unknownLastAgain, unknown), undefined);
  assert.deepEqual(unknownLastAgain.usage.cost, unknownCost);

  controller.rewriteProviderPayload({ model: unknown.model.id }, unknown);
  for (const stopReason of ['error', 'aborted'] as const) {
    const terminal = assistant(unknown.model);
    terminal.stopReason = stopReason;
    const before = { ...terminal.usage.cost };
    assert.equal(controller.rewriteAssistantMessage(terminal, unknown), undefined);
    assert.deepEqual(terminal.usage.cost, before);
    if (stopReason === 'error') controller.rewriteProviderPayload({ model: unknown.model.id }, unknown);
  }
  controller.shutdown();
});

test('Fast machine preference restores, refreshes across windows, persists Off, and counts only refreshed command transitions', async t => {
  const root = mkdtempSync(join(suiteAgentDir, 'shared-machine-'));
  const facts: any[] = [];
  const deps = { writeFastEnabledEvent: async (record: any) => { facts.push(record); return record; }, submitMetric: async () => {} } as any;
  const a = sharedMachineHarness(root, deps), b = sharedMachineHarness(root, deps);
  const ca = context(), cb = context();
  await a.handlers.get('session_start')?.({}, ca);
  await b.handlers.get('session_start')?.({}, cb);
  await a.command('on', ca);
  await b.handlers.get('input')?.({}, cb);
  assert.equal(b.handlers.get('before_provider_request')?.({ payload: { model: cb.model.id } }, cb)?.service_tier, 'priority', 'next input refresh adopts other window On');
  await b.command('on', cb);
  await b.command('off', cb);
  a.emitted.length = 0;
  await a.command('on', ca); // Internal command refresh must apply B's Off before re-enabling A.
  assert.deepEqual(a.emitted, [], 'machine preference adoption does not use a parent-session interop event');
  assert.equal((await readPreference(root, 'codex-fast') as any).snapshot.enabled, true);
  assert.equal(a.handlers.get('before_provider_request')?.({ payload: { model: ca.model.id } }, ca)?.service_tier, 'priority');
  await a.handlers.get('session_shutdown')?.({}, ca);
  await b.handlers.get('session_shutdown')?.({}, cb);
  assert.equal(facts.length, 1, 'only the actual Off→On command after the external Off counts');
  assert.equal((await readPreference(root, 'codex-fast') as any).snapshot.enabled, true);

  const headless = sharedMachineHarness(root);
  const json = context(model(), { mode: 'json', hasUI: false });
  await headless.handlers.get('session_start')?.({}, json);
  assert.equal(headless.handlers.get('before_provider_request')?.({ payload: { model: json.model.id } }, json)?.service_tier, 'priority', 'machine On applies to a headless child');
  await headless.command('on', json);
  assert.equal((await readPreference(root, 'codex-fast') as any).snapshot.enabled, true, 'headless command cannot mutate machine preference');
  await headless.handlers.get('session_shutdown')?.({}, json);
  t.after(() => rm(root, { recursive: true, force: true }));
});

test('Fast sends the captured committed fact to the metric queue only after local write succeeds',async()=>{ const records:any[]=[];let fact:any;const h=commandHarness(()=>{}, {writeFastEnabledEvent:async record=>{fact=record;return record;},submitMetric:async event=>{records.push(event);}});const ctx=context();await h.command('on',ctx);assert.deepEqual(records,[], 'writer/outbox must not run in the command');await h.command('on',ctx);await h.handlers.get('session_shutdown')?.({},ctx);assert.deepEqual(records,[{schemaVersion:1,eventId:fact.eventId,kind:'fast_enabled',occurredAt:fact.occurredAt,dataset:'live'}]);});

test('only actual UI Off→On commands record independent events; model/initialization/shutdown never do', async (t) => {
  const path = isolatedEvents(t);
  const emitted: unknown[] = [];
  const { handlers, command } = commandHarness((_name, data) => emitted.push(data));
  const ctx = context();
  await handlers.get('session_start')?.({}, ctx);
  assert.deepEqual(await eventRecords(path), []);
  await command('on', ctx);
  let records = await waitForEvents(path, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].name, `${records[0].record.eventId}.json`);
  assert.deepEqual(Object.keys(records[0].record), ['schemaVersion', 'eventId', 'occurredAt', 'source']);
  assert.equal(records[0].record.schemaVersion, 1);
  assert.equal(records[0].record.source, 'user_command');
  await command('on', ctx);
  await command('status', ctx);
  await command('invalid', ctx);
  await command('off', ctx);
  await command('on', ctx);
  records = await waitForEvents(path, 2);
  assert.equal(records.length, 2);
  assert.notEqual(records[0].record.eventId, records[1].record.eventId);
  await command('off', ctx);
  await command('toggle', ctx);
  records = await waitForEvents(path, 2);
  assert.equal(records.length, 2);
  assert.equal(new Set(records.map(({ record }) => record.eventId)).size, 2);
  const json = context(model(), { mode: 'json', hasUI: false });
  await command('off', json);
  await command('on', json);
  assert.equal((await eventRecords(path)).length, 2);
  handlers.get('model_select')?.({ model: model('gpt-'), previousModel: ctx.model, source: 'set' }, ctx);
  handlers.get('session_shutdown')?.({}, ctx);
  assert.equal((await eventRecords(path)).length, 2);
  assert.deepEqual(emitted, [], 'Fast state is observed from the machine preference rather than a parent-session event');

  const next = commandHarness();
  const newCtx = context();
  await next.handlers.get('session_start')?.({}, newCtx);
  assert.equal(next.handlers.get('before_provider_request')?.({ payload: { model: 'gpt-5.4' } }, newCtx), undefined);
  assert.equal((await eventRecords(path)).length, 2);
});

test('RPC and ineligible user intent count; inherited startup and model changes do not', async (t) => {
  const path = isolatedEvents(t);
  const previous = process.env.PI_CODEX_FAST;
  try {
    process.env.PI_CODEX_FAST = '1';
    const child = commandHarness();
    const inherited = context(model('gpt-'), { mode: 'rpc', hasUI: true });
    await child.handlers.get('session_start')?.({}, inherited);
    child.handlers.get('model_select')?.({ model: model('gpt-5.4'), previousModel: inherited.model, source: 'set' }, inherited);
    child.handlers.get('session_shutdown')?.({}, inherited);
    assert.deepEqual(await eventRecords(path), []);
    const parent = commandHarness();
    await parent.command('on', context(model('gpt-'), { mode: 'rpc', hasUI: true }));
    const records = await waitForEvents(path, 1);
    assert.equal(records.length, 1);
    assert.equal(records[0].record.source, 'user_command');
  } finally {
    if (previous === undefined) delete process.env.PI_CODEX_FAST;
    else process.env.PI_CODEX_FAST = previous;
  }
});

test('no-assistant and no-session command paths persist without appending a session entry', async (t) => {
  const path = isolatedEvents(t);
  for (const noSession of [false, true]) {
    const { command } = commandHarness();
    const ctx = context(model(), {
      sessionManager: {
        getSessionId: () => noSession ? 'memory-only' : 'no-assistant',
        getSessionFile: () => undefined,
      },
    });
    await command('on', ctx);
  }
  assert.equal((await waitForEvents(path, 2)).length, 2);
});

test('original UI notification or bus errors after Off→On do not suppress the record or get replaced', async (t) => {
  const path = isolatedEvents(t);
  const notificationError = new Error('original notification error');
  const brokenNotification = commandHarness();
  const badCtx = context();
  badCtx.ui.notify = () => { throw notificationError; };
  await assert.rejects(brokenNotification.command('on', badCtx), (error: unknown) => error === notificationError);
  assert.equal((await waitForEvents(path, 1)).length, 1);
  assert.equal(brokenNotification.handlers.get('before_provider_request')?.({ payload: { model: 'gpt-5.4' } }, badCtx)?.service_tier, 'priority');

  const busError = new Error('original bus error');
  const brokenBus = commandHarness(() => { throw busError; });
  const ctx = context();
  await assert.doesNotReject(brokenBus.command('on', ctx));
  assert.equal((await waitForEvents(path, 2)).length, 2);
  assert.equal(brokenBus.handlers.get('before_provider_request')?.({ payload: { model: 'gpt-5.4' } }, ctx)?.service_tier, 'priority');
});

test('storage and safety-notice failures neither leak path/error nor roll back Fast or bus', async (t) => {
  const path = isolatedEvents(t);
  const badRoot = join(path, 'no-such-root');
  await mkdir(path, { recursive: true });
  await writeFile(badRoot, 'not-a-directory');
  process.env.PI_CODING_AGENT_DIR = badRoot;
  const emitted: unknown[] = [];
  const { command, handlers } = commandHarness((_name, data) => emitted.push(data));
  const ctx = context();
  await command('on', ctx);
  await waitForNotice(ctx);
  assert.deepEqual(ctx._notices.at(-1), { message: '本次计量记录无法确认', type: 'warning' });
  assert.equal(ctx._notices.some(({ message }: { message: string }) => message.includes(badRoot)), false);
  assert.deepEqual(emitted, [], 'storage failure does not emit a legacy interop event');
  assert.equal(handlers.get('before_provider_request')?.({ payload: { model: 'gpt-5.4' } }, ctx)?.service_tier, undefined);
  assert.deepEqual(await eventRecords(path), []);
  const notices: string[] = [];
  const another = commandHarness();
  const noticeFailure = context();
  noticeFailure.ui.notify = (message: string) => { notices.push(message); if (message === '本次计量记录无法确认') throw new Error('notice failed'); };
  await another.command('on', noticeFailure);
  const until = Date.now() + 1200;
  while (notices.at(-1) !== '本次计量记录无法确认' && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(notices.at(-1), '本次计量记录无法确认');
  assert.equal(another.handlers.get('before_provider_request')?.({ payload: { model: 'gpt-5.4' } }, noticeFailure)?.service_tier, undefined);
});

test('unsafe directory permission and simultaneous bus failure keep the original exception', async (t) => {
  const path = isolatedEvents(t);
  const root = process.env.PI_CODING_AGENT_DIR as string;
  const badRoot = join(root, 'not-a-directory');
  await writeFile(badRoot, 'not-a-directory');
  process.env.PI_CODING_AGENT_DIR = badRoot;
  const busError = new Error('original bus error');
  const notices: string[] = [];
  const { command, handlers } = commandHarness(() => { throw busError; });
  const ctx = context();
  ctx.ui.notify = (message: string) => {
    notices.push(message);
    if (message === '本次计量记录无法确认') throw new Error('safety notify error');
  };
  await assert.doesNotReject(command('on', ctx));
  const until = Date.now() + 1200;
  while (notices.at(-1) !== '本次计量记录无法确认' && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(notices.at(-1), '本次计量记录无法确认');
  assert.equal(handlers.get('before_provider_request')?.({ payload: { model: 'gpt-5.4' } }, ctx)?.service_tier, undefined);
  assert.deepEqual(await eventRecords(path), []);
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
  assert.equal(firstContext._statuses.every((status) => status.text === undefined), true);

  const second = makeHarness();
  const secondContext = context();
  await second.handlers.get('session_start')?.({}, secondContext);
  assert.equal(secondContext._statuses.every((status) => status.text === undefined), true);
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

test('package exports interop without changing the Pi extension entry', async () => {
  const packageJson = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(packageJson.pi.extensions, ['src/index.ts']);
  assert.deepEqual(packageJson.exports['./interop'], {
    types: './src/interop.ts',
    import: './src/interop.ts',
  });
});

test('Fast interop remains a strict compatibility parser, while extension state is machine-owned', async () => {
  const valid = { version: 1, sessionId: 's', requested: true };
  assert.deepEqual(parseFastRequestedEvent(valid), valid);
  for (const malformed of [null, [], { ...valid, extra: true }, { ...valid, version: '1' }, { ...valid, sessionId: '' }, { ...valid, requested: 1 }]) assert.equal(parseFastRequestedEvent(malformed), undefined);
  const emitted: unknown[] = [];
  const h = commandHarness((_name, data) => emitted.push(data));
  const ctx = context();
  await h.handlers.get('session_start')?.({}, ctx);
  await h.command('on', ctx);
  assert.deepEqual(emitted, [], 'parent-session interop is not the Fast state channel');
  assert.equal((await readPreference(process.env.PI_CODING_AGENT_DIR!, 'codex-fast') as any).snapshot.enabled, true);
});

test('JSON and subagent instances read the shared machine preference; inherited environment is ignored', async () => {
  const h = commandHarness();
  const main = context(model('gpt-5.4', { api: 'openai-codex-responses' }), { mode: 'json', hasUI: false });
  assert.equal(isFastEligible(main), true);
  await writeMachinePreference('fast', true, join(process.env.PI_CODING_AGENT_DIR!, 'settings.json'));
  assert.equal((await readMachinePreference('fast', join(process.env.PI_CODING_AGENT_DIR!, 'settings.json'))).value, true);
  await h.handlers.get('session_start')?.({}, main);
  await h.handlers.get('input')?.({}, main);
  const payload = { model: 'gpt-5.4', service_tier: 'default' };
  const rewritten = h.handlers.get('before_provider_request')?.({ payload }, main);
  assert.equal((rewritten ?? payload).service_tier, 'priority');
});

test('/fast refreshes the merged widget without re-running usage work', async () => {
  const handlers = new Map<string, Function>();
  let command: ((args: string, ctx: any) => Promise<void>) | undefined;
  const api: any = {
    on: (name: string, handler: Function) => handlers.set(name, handler),
    events: { emit: () => {}, on: () => () => {} },
    registerCommand: (_name: string, options: { handler: typeof command }) => { command = options.handler; },
  };
  extension(api);
  const widgetRows: string[] = [];
  let authCalls = 0;
  let fetchCalls = 0;
  let timerCalls = 0;
  const ctx = context(model(), {
    modelRegistry: {
      isUsingOAuth: () => true,
      getProviderAuth: async () => { authCalls += 1; throw new Error('pending auth'); },
    },
    ui: {
      ...context().ui,
      setWidget: (_key: string, content: unknown) => {
        if (typeof content === 'function') widgetRows.push((content as Function)({}, ctx.ui.theme).render(200)[0]);
      },
    },
  });
  const originalSetTimeout = globalThis.setTimeout;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => { timerCalls += 1; return originalSetTimeout(...args); }) as typeof setTimeout;
    globalThis.fetch = (async () => { fetchCalls += 1; throw new Error('Fast must not fetch usage'); }) as typeof fetch;
    await handlers.get('session_start')?.({}, ctx);
    const before = { authCalls, fetchCalls, timerCalls };
    await command?.('on', ctx);
    assert.equal(authCalls, before.authCalls);
    assert.equal(fetchCalls, before.fetchCalls);
    assert.equal(timerCalls - before.timerCalls, 1, 'Fast command only uses the preference lock timer; it does not start a local-commit deadline');
    assert.match(widgetRows.at(-1) ?? '', /^\u001b\[38;2;217;140;63m⚡ Fast\u001b\[0m · /u);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.fetch = originalFetch;
    await handlers.get('session_shutdown')?.({}, ctx);
  }
});

test('lifecycle projects the updated Fast state before hiding on a gate failure', async () => {
  const handlers = new Map<string, Function>();
  let command: ((args: string, ctx: any) => Promise<void>) | undefined;
  const api: any = {
    on: (name: string, handler: Function) => handlers.set(name, handler),
    events: { emit: () => {}, on: () => () => {} },
    registerCommand: (_name: string, options: { handler: typeof command }) => { command = options.handler; },
  };
  extension(api);
  const rows: string[] = [];
  const ctx = context(model(), {
    ui: {
      ...context().ui,
      setWidget: (_key: string, content: unknown) => {
        rows.push(typeof content === 'function'
          ? (content as Function)({}, ctx.ui.theme).render(200)[0]
          : '<cleared>');
      },
    },
  });

  await handlers.get('session_start')?.({}, ctx);
  assert.match(rows.at(-1) ?? '', /Fast off/u);
  await command?.('on', ctx);
  assert.match(rows.at(-1) ?? '', /^\u001b\[38;2;217;140;63m⚡ Fast\u001b\[0m · /u);

  await handlers.get('model_select')?.({ model: model('gpt-'), previousModel: ctx.model, source: 'set' }, ctx);
  assert.match(rows.at(-1) ?? '', /Fast inactive/u);
  await handlers.get('model_select')?.({ model: model('other', { provider: 'other' }), previousModel: ctx.model, source: 'set' }, ctx);
  assert.equal(rows.at(-1), '<cleared>');

  handlers.get('session_shutdown')?.({}, ctx);
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
