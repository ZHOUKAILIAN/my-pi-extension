import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMachinePreference, writeMachinePreference } from '../src/machine-settings.ts';
const readPreference = async (root: string, _name: string) => { const result = await readMachinePreference('asyncCompaction', `${root}/settings.json`); return { snapshot: { enabled: result.value ?? false } }; };
const writePreference = async (root: string, _name: string, value: boolean) => writeMachinePreference('asyncCompaction', value, `${root}/settings.json`);
import { SessionManager } from '@earendil-works/pi-coding-agent';
import extension from '../src/index.ts';

const cli = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')).replace(/\/dist\/index\.js$/, '/dist/bundle/cli.js');
const prefs: string[] = [];
test.after(() => { for (const dir of prefs) rmSync(dir, { recursive: true, force: true }); });
function harness(agentDir: string, contextOverrides: Record<string, unknown> = {}) {
  const lists = new Map<string, Function[]>(), handlers = new Map<string, Function>(), entries: { type: string; data: any }[] = []; let command!: (args: string, ctx: any) => Promise<void>;
  const emit = async (name: string, ...args: any[]) => { let result: unknown; for (const callback of lists.get(name) ?? []) { const value = await callback(...args); if (value !== undefined) result = value; } return result; };
  const pi: any = {
    registerCommand: (_name: string, options: any) => { command = options.handler; },
    registerEntryRenderer() {}, appendEntry: (type: string, data: any) => entries.push({ type, data }), getSettings: () => ({ compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 1 } }), getAllTools: () => [], getActiveTools: () => [],
    on: (name: string, callback: Function) => { const entries = lists.get(name) ?? []; entries.push(callback); lists.set(name, entries); handlers.set(name, (...args: any[]) => emit(name, ...args)); },
  };
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  try { extension(pi, { settingsFile: join(agentDir, 'settings.json'), submitMetric: async () => { throw new Error('unexpected metric'); } }); }
  finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; }
  const notices: string[] = [];
  const ctx = {
    mode: 'tui', model: undefined, thinkingLevel: 'off', hasPendingMessages: () => false, getContextUsage: () => null,
    getSystemPrompt: () => 'test system',
    ui: { notify: (message: string) => notices.push(message), onTerminalInput: () => () => {} },
    sessionManager: { getSessionId: () => 'session-1', getBranch: () => [], getLeafId: () => null },
    ...contextOverrides,
  } as any;
  return { handlers, command, ctx, notices, emit, entries };
}
function supportedArgv(): string[] { return ['node', cli]; }

test('preference command tests ignore inherited external settings override and only write their fixture root', async () => {
  const externalRoot = mkdtempSync(join(tmpdir(), 'async-external-sentinel-'));
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'async-isolated-preference-fixture-'));
  prefs.push(externalRoot, fixtureRoot);
  const externalFile = join(externalRoot, 'settings.json'), fixtureFile = join(fixtureRoot, 'settings.json');
  const sentinel = Buffer.from('{"sentinel":"must-remain-byte-identical","myPiExtensions":{"fast":true,"asyncCompaction":true}}\n');
  const parsedSentinel = JSON.parse(sentinel.toString('utf8'));
  assert.equal(parsedSentinel.myPiExtensions.asyncCompaction, true, 'the original sentinel bytes are valid JSON with On enabled');
  writeFileSync(externalFile, sentinel);
  const assertExternalUnchanged = () => assert.deepEqual(readFileSync(externalFile), sentinel, 'external sentinel bytes remain unchanged');
  await writeMachinePreference('asyncCompaction', false, externalFile); // Negative control: only this synthetic temp file is deliberately changed.
  assert.deepEqual(await readMachinePreference('asyncCompaction', externalFile), { value: false, valid: true });
  assert.throws(assertExternalUnchanged, (error: unknown) => (error as NodeJS.ErrnoException).code === 'ERR_ASSERTION', 'the sentinel regression assertion detects a valid external rewrite');
  writeFileSync(externalFile, sentinel);
  assert.deepEqual(await readMachinePreference('asyncCompaction', externalFile), { value: true, valid: true }, 'the restored sentinel is accepted by the machine-settings reader');
  const oldOverride = process.env.PI_MY_EXTENSIONS_SETTINGS_FILE, oldArgv = process.argv;
  process.env.PI_MY_EXTENSIONS_SETTINGS_FILE = externalFile; process.argv = supportedArgv();
  try {
    const h = harness(fixtureRoot);
    await h.emit('session_start', {}, h.ctx);
    await h.command('off', h.ctx);
    assertExternalUnchanged();
    assert.equal((await readMachinePreference('asyncCompaction', fixtureFile)).value, false, 'off writes the explicit synthetic fixture');
    await h.command('on', h.ctx);
    assertExternalUnchanged();
    assert.equal((await readMachinePreference('asyncCompaction', fixtureFile)).value, true, 'all writes stay under the assigned test root');
  } finally {
    process.argv = oldArgv;
    if (oldOverride === undefined) delete process.env.PI_MY_EXTENSIONS_SETTINGS_FILE; else process.env.PI_MY_EXTENSIONS_SETTINGS_FILE = oldOverride;
  }
});

test('Async restores On/Off across instances; valid unsupported model keeps latent On; bad profile never touches preference', async t => {
  const root = mkdtempSync(join(tmpdir(), 'async-machine-prefs-')); prefs.push(root); t.after(() => {});
  const oldArgv = process.argv; process.argv = supportedArgv();
  try {
    const first = harness(root); await first.emit('session_start', {}, first.ctx);
    await first.command('on', first.ctx);
    assert.equal((await readPreference(root, 'async-compaction') as any).snapshot.enabled, true);
    assert.match(first.notices.at(-1)!, /preference is On/u, 'model unsupported is latent rather than rejected');
    await first.emit('session_shutdown', {}, first.ctx);
    const restarted = harness(root); await restarted.emit('session_start', {}, restarted.ctx);
    await restarted.command('off', restarted.ctx);
    assert.equal((await readPreference(root, 'async-compaction') as any).snapshot.enabled, false);
    await restarted.emit('session_shutdown', {}, restarted.ctx);
    const offAgain = harness(root); await offAgain.emit('session_start', {}, offAgain.ctx);
    assert.equal(offAgain.notices.length, 0);
    await offAgain.emit('session_shutdown', {}, offAgain.ctx);

    process.argv = ['node', 'unsupported-cli'];
    const unsupported = harness(root); await unsupported.emit('session_start', {}, unsupported.ctx);
    await unsupported.command('on', unsupported.ctx);
    assert.equal((await readPreference(root, 'async-compaction') as any).snapshot.enabled, false);
    await unsupported.emit('session_shutdown', {}, unsupported.ctx);
  } finally { process.argv = oldArgv; }
});

test('command-internal external Off cancels a real pending candidate before On and fences its late result', async t => {
  const root = mkdtempSync(join(tmpdir(), 'async-command-off-fence-')); prefs.push(root);
  await writePreference(root, 'async-compaction', true);
  const session = SessionManager.inMemory(root);
  const usage = { input: 18, output: 9, cacheRead: 0, cacheWrite: 0, totalTokens: 27, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  for (let n = 1; n <= 2; n++) {
    session.appendMessage({ role: 'user', content: [{ type: 'text', text: `user-${n} ` + 'word '.repeat(160) }], timestamp: Date.now() });
    session.appendMessage({ role: 'assistant', content: [{ type: 'text', text: `answer-${n} ` + 'answer '.repeat(40) }], api: 'fake-api', provider: 'fake', model: 'm', stopReason: 'stop', timestamp: Date.now(), usage });
  }
  let settle!: (message: unknown) => void;
  const signals: AbortSignal[] = [];
  const ctx: any = {
    mode: 'tui', model: { provider: 'fake', id: 'm', api: 'fake-api', contextWindow: 4096 }, thinkingLevel: 'off',
    sessionManager: session, hasPendingMessages: () => false, getSystemPrompt: () => 'system', getContextUsage: () => ({ tokens: 2900, contextWindow: 4096 }),
    modelRegistry: { streamSimple: (_model: unknown, _messages: unknown, options: { signal: AbortSignal }) => { signals.push(options.signal); return { result: () => new Promise(resolve => { settle = resolve; }) }; } },
    ui: { notify() {}, onTerminalInput: () => () => {} },
  };
  const oldArgv = process.argv; process.argv = supportedArgv();
  try {
    const h = harness(root, ctx); await h.emit('session_start', {}, ctx);
    await h.emit('turn_end', { message: { role: 'assistant', stopReason: 'stop' } }, ctx);
    assert.equal(signals.length, 1, 'a real Async candidate began generating');
    await writePreference(root, 'async-compaction', false); // B commits Off.
    await h.command('on', ctx); // A must apply Off before executing On.
    assert.equal(signals[0].aborted, true, 'command-internal refresh uses the same accepted-Off cancellation path');
    assert.equal((await readPreference(root, 'async-compaction') as any).snapshot.enabled, true);
    settle({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'late summary' }], usage, api: 'fake-api', provider: 'fake', model: 'm', timestamp: Date.now() });
    await new Promise<void>(resolve => setImmediate(resolve)); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(session.getBranch().some(entry => entry.type === 'compaction' && entry.fromHook), false, 'late stale candidate never reaches the native branch');
    await h.emit('agent_end', { messages: [] }, ctx);
    const beforeCompact = { reason: 'threshold', signal: new AbortController().signal, preparation: { settings: { enabled: true, reserveTokens: 512, keepRecentTokens: 1 }, fileOps: { read: new Set<string>(), edited: new Set<string>() } } };
    const fallback = await h.emit('session_before_compact', beforeCompact, ctx) as { cancel?: boolean } | undefined;
    assert.ok(fallback && 'cancel' in fallback, 'an empty Async offer retains the final native-preparation guard');
    assert.equal(fallback.cancel, false, 'unchanged history permits native fallback after the late cancelled candidate settles');
    assert.equal(signals.length, 1, 'refresh plus user On does not launch a replacement task');
    await h.emit('session_shutdown', {}, ctx);
  } finally { process.argv = oldArgv; }
});

test('tool-turn scheduling re-reads Off and fails closed on preference errors; soft threshold still gates requests', async t => {
  const oldArgv = process.argv; process.argv = supportedArgv();
  try {
    for (const scenario of ['fresh-off', 'read-failure', 'below-threshold', 'tool-error'] as const) {
      const root = mkdtempSync(join(tmpdir(), `async-tool-turn-${scenario}-`)); prefs.push(root);
      await writePreference(root, 'async-compaction', true);
      const sm = SessionManager.inMemory(root);
      const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      for (let n = 0; n < 3; n++) {
        sm.appendMessage({ role: 'user', content: [{ type: 'text', text: `history-${n} ` + 'constraint '.repeat(400) }], timestamp: Date.now() });
        sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: `answer-${n} ` + 'fact '.repeat(30) }], api: 'fake-api', provider: 'fake', model: 'm', stopReason: 'stop', timestamp: Date.now(), usage });
      }
      const call = { type: 'toolCall' as const, id: 'tool-call', name: 'read', arguments: { path: 'a.ts' } };
      const assistant = { role: 'assistant' as const, content: [call], api: 'fake-api', provider: 'fake', model: 'm', stopReason: 'toolUse' as const, timestamp: Date.now(), usage };
      const assistantId = sm.appendMessage(assistant);
      const result = { role: 'toolResult' as const, toolCallId: call.id, toolName: call.name, content: [{ type: 'text' as const, text: 'done' }], isError: scenario === 'tool-error', timestamp: Date.now() };
      const resultId = sm.appendMessage(result);
      let calls = 0;
      const ctx: any = {
        mode: 'tui', model: { provider: 'fake', id: 'm', api: 'fake-api', contextWindow: 4096 }, thinkingLevel: 'off', sessionManager: sm,
        hasPendingMessages: () => false, getSystemPrompt: () => 'system', getContextUsage: () => ({ tokens: scenario === 'below-threshold' ? 1000 : 3000, contextWindow: 4096 }),
        modelRegistry: { streamSimple: () => { calls++; return { result: () => new Promise(() => {}) }; } },
        ui: { notify() {}, onTerminalInput: () => () => {} },
      };
      const h = harness(root, ctx);
      await h.emit('session_start', {}, ctx);
      if (scenario === 'fresh-off') await writePreference(root, 'async-compaction', false);
      if (scenario === 'read-failure') writeFileSync(join(root, 'settings.json'), '{broken');
      const event = { message: assistant, outcome: 'completed', toolResults: [result], messageEntryId: assistantId, toolResultEntryIds: [resultId] };
      await h.emit('turn_end', event, ctx);
      assert.equal(calls, 0, `${scenario} must not launch an extra provider request`);
      const gate = scenario === 'fresh-off' ? 'preference_off' : scenario === 'read-failure' ? 'preference_read_failed' : scenario === 'tool-error' ? 'incomplete_turn' : 'below_threshold';
      assert.equal(h.entries.find(entry => entry.type === 'async-compact-schedule')?.data.reason, gate, `${scenario} is observable as a finite safe scheduling reason`);
      assert.equal(h.entries.find(entry => entry.type === 'async-compact-schedule')?.data.trigger, scenario === 'tool-error' ? 'unknown' : 'completed_tool_turn', 'only complete result batches receive the completed-tool-turn trigger');
      assert.equal(h.entries.some(entry => entry.type === 'async-compact-progress'), false, 'schedule diagnostics do not create visible progress');
      await h.emit('session_shutdown', {}, ctx);
    }
  } finally { process.argv = oldArgv; }
});

test('successful tree reloads preference; cancellable before-navigation hooks do not reset it; shutdown never writes Off', async t => {
  const root = mkdtempSync(join(tmpdir(), 'async-tree-prefs-')); prefs.push(root); t.after(() => {});
  const oldArgv = process.argv; process.argv = supportedArgv();
  try {
    const h = harness(root); await h.emit('session_start', {}, h.ctx); await h.command('on', h.ctx);
    assert.equal(h.handlers.has('session_before_tree'), false);
    await h.emit('session_tree', { newLeafId: 'new' }, h.ctx);
    assert.equal((await readPreference(root, 'async-compaction') as any).snapshot.enabled, true);
    await h.emit('session_shutdown', { reason: 'reload' }, h.ctx);
    assert.equal((await readPreference(root, 'async-compaction') as any).snapshot.enabled, true, 'reload teardown does not persist Off');
    const replacement = harness(root); await replacement.emit('session_start', { reason: 'reload' }, replacement.ctx);
    await replacement.command('off', replacement.ctx);
    assert.equal((await readPreference(root, 'async-compaction') as any).snapshot.enabled, false);
    await replacement.emit('session_shutdown', {}, replacement.ctx);
  } finally { process.argv = oldArgv; }
});
