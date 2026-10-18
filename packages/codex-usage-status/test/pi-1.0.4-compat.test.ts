import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const hostRoot = process.env.PI_CODING_AGENT_1_0_4_PATH;

test('Pi 1.0.4 loads the package and runs its command, event, UI and shutdown contracts', {
  skip: !hostRoot && 'Set PI_CODING_AGENT_1_0_4_PATH to the installed Pi 1.0.4 package directory',
}, async (t) => {
  const root = hostRoot!;
  const hostManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string; dependencies: Record<string, string> };
  assert.equal(hostManifest.version, '1.0.4');

  const importHost = async (relativePath: string) => import(pathToFileURL(join(root, relativePath)).href);
  const [{ discoverAndLoadExtensions }, { createEventBus }, { ExtensionRunner }, piTui, piAi] = await Promise.all([
    importHost('dist/core/extensions/loader.js'),
    importHost('dist/core/event-bus.js'),
    importHost('dist/core/extensions/runner.js'),
    importHost('node_modules/@earendil-works/pi-tui/dist/index.js'),
    importHost('node_modules/@earendil-works/pi-ai/dist/index.js'),
  ]);
  const tempDir = await mkdtemp(join(tmpdir(), 'pi-1.0.4-codex-compat-'));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tempDir;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(tempDir, { recursive: true, force: true });
  });

  const installedPackage = join(tempDir, 'installed', 'codex-usage-status');
  await mkdir(join(installedPackage, 'node_modules', '@earendil-works'), { recursive: true });
  await mkdir(join(installedPackage, 'node_modules', '@pi'), { recursive: true });
  await cp(join(process.cwd(), 'packages/codex-usage-status', 'src'), join(installedPackage, 'src'), { recursive: true });
  await cp(join(process.cwd(), 'packages/codex-usage-status', 'package.json'), join(installedPackage, 'package.json'));
  for (const name of ['pi-coding-agent', 'pi-ai', 'pi-tui']) {
    await symlink(join(root, 'node_modules', '@earendil-works', name), join(installedPackage, 'node_modules', '@earendil-works', name), 'dir');
  }
  await symlink(join(process.cwd(), 'packages/project-metrics'), join(installedPackage, 'node_modules', '@pi/project-metrics'), 'dir');

  const events = createEventBus();
  const published: Array<{ channel: string; data: unknown }> = [];
  events.on('@pi/codex-usage-status:fast-requested/v1', (data: unknown) => published.push({ channel: '@pi/codex-usage-status:fast-requested/v1', data }));
  const loaded = await discoverAndLoadExtensions([installedPackage], process.cwd(), tempDir, events);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1, 'package manifest entry is loaded by Pi’s native extension loader');

  const model = {
    id: 'gpt-5.4', name: 'gpt-5.4', provider: 'openai-codex', api: 'openai-codex-responses',
    baseUrl: 'https://chatgpt.com/backend-api', reasoning: true, thinkingLevelMap: {},
    cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 3 },
  };
  const uiCalls: Array<{ method: string; args: unknown[] }> = [];
  const recordUI = (method: string) => (...args: unknown[]) => { uiCalls.push({ method, args }); };
  const ui = {
    notify: recordUI('notify'),
    setStatus: recordUI('setStatus'),
    setWidget: recordUI('setWidget'),
    theme: { fg: (_color: string, text: string) => text },
  };
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, process.cwd(), {
    getSessionId: () => 'pi-1.0.4-compat-session',
    getSessionFile: () => join(tempDir, 'session.jsonl'),
    getCwd: () => process.cwd(),
  }, {
    isUsingOAuth: () => true,
    getProviderAuth: async () => { throw new Error('No auth lookup expected in this compatibility test'); },
  });
  const actions = new Proxy({}, { get: () => () => undefined });
  runner.bindCore(actions, {
    getModel: () => model,
    getScopedModels: () => [],
    isIdle: () => true,
    isProjectTrusted: () => true,
    getSignal: () => new AbortController().signal,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => '',
  });
  runner.setUIContext(ui as never, 'tui');

  for (const eventName of ['session_start', 'input', 'model_select', 'agent_settled', 'before_provider_request', 'message_end', 'session_tree', 'session_shutdown']) {
    assert.equal(runner.hasHandlers(eventName), true, `Pi 1.0.4 recognizes registered ${eventName} handlers`);
  }
  assert.ok(runner.getCommand('fast'), 'Fast slash command registered through ExtensionAPI');
  await runner.getCommand('fast')!.handler('on', runner.createCommandContext());
  assert.deepEqual(await runner.emitBeforeProviderRequest({ model: 'gpt-5.4', input: [] }), {
    model: 'gpt-5.4', input: [], service_tier: 'priority',
  }, 'native ExtensionRunner chains before_provider_request replacement results');
  assert.deepEqual(published.at(-1)?.data, {
    version: 1, sessionId: 'pi-1.0.4-compat-session', requested: true,
  }, 'Pi event bus carries the exact versioned, session-scoped interop payload');

  await runner.emit({ type: 'session_start', resumedFrom: undefined });
  assert.ok(uiCalls.some(({ method }) => method === 'setStatus'), 'real ExtensionRunner context exposes the UI status contract');
  const widgetCall = uiCalls.find(({ method, args }) => method === 'setWidget' && args[0] === 'codex-usage-status' && args[2] !== undefined);
  assert.ok(widgetCall, 'extension uses the native widget contract');
  assert.equal(typeof widgetCall.args[1], 'function', 'widget content is a Pi component factory, not footer text');
  assert.deepEqual(widgetCall.args[2], { placement: 'belowEditor' }, 'widget placement matches Pi 1.0.4 API');
  const component = (widgetCall.args[1] as (tui: unknown, theme: unknown) => { render(width: number): string[] })(undefined, undefined);
  const rendered = component.render(10);
  assert.equal(rendered.length, 1, 'component render returns one line');
  assert.equal(rendered[0], piTui.truncateToWidth('\u001b[38;2;217;140;63m⚡ Fast\u001b[0m · Codex: unavailable', 10, ''), 'widget output follows the real 1.0.4 ANSI-safe truncation contract');

  await runner.emit({ type: 'session_shutdown', reason: 'quit' });
  assert.deepEqual(published.at(-1)?.data, {
    version: 1, sessionId: 'pi-1.0.4-compat-session', requested: false,
  }, 'native shutdown event clears and publishes Fast intent');
  assert.ok(uiCalls.some(({ method, args }) => method === 'setWidget' && args[0] === 'codex-usage-status' && args[1] === undefined), 'shutdown clears the widget');

  const nativeCost = piAi.calculateCost(model, {
    input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000,
    totalTokens: 4_000_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
  assert.deepEqual(nativeCost, { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 3, total: 6.5 }, 'Fast cost correction’s Pi AI calculateCost dependency is available with the same cost contract');

  const peerVersions = await Promise.all(['@earendil-works/pi-ai', '@earendil-works/pi-tui'].map(async (name) => {
    const manifestPath = join(root, 'node_modules', name, 'package.json');
    return (JSON.parse(await readFile(manifestPath, 'utf8')) as { version: string }).version;
  }));
  assert.deepEqual(peerVersions, ['1.0.4', '1.0.4']);
});
