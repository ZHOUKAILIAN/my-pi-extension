import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const packageRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(packageRoot, '../..');

for (const expectedHostVersion of ['1.0.4', '1.1.0']) {
  const envName = `PI_CODING_AGENT_${expectedHostVersion.replaceAll('.', '_')}_PATH`;
  const hostRoot = process.env[envName];
  test(`Pi ${expectedHostVersion} loads codex usage with installed runtime dependencies and machine preferences`, {
    skip: !hostRoot && `Set ${envName} to the installed Pi package directory`, timeout: 120_000,
  }, async (t) => {
    const root = hostRoot!;
    const hostManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string };
    assert.equal(hostManifest.version, expectedHostVersion);

    const tempDir = await mkdtemp(join(tmpdir(), 'pi-codex-compat-'));
    const installedPackage = join(tempDir, 'installed', 'codex-usage-status');
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousSettingsFile = process.env.PI_MY_EXTENSIONS_SETTINGS_FILE;
    process.env.PI_CODING_AGENT_DIR = tempDir;
    process.env.PI_MY_EXTENSIONS_SETTINGS_FILE = join(tempDir, 'settings.json');
    t.after(async () => {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousSettingsFile === undefined) delete process.env.PI_MY_EXTENSIONS_SETTINGS_FILE;
      else process.env.PI_MY_EXTENSIONS_SETTINGS_FILE = previousSettingsFile;
      await rm(tempDir, { recursive: true, force: true });
    });

    await mkdir(installedPackage, { recursive: true });
    await cp(join(packageRoot, 'src'), join(installedPackage, 'src'), { recursive: true });
    await cp(join(packageRoot, 'package.json'), join(installedPackage, 'package.json'));
    // Install the package's real production dependency instead of copying source without its runtime graph.
    const runtimeDeps = join(tempDir, 'runtime-deps');
    await mkdir(runtimeDeps);
    await writeFile(join(runtimeDeps, 'package.json'), JSON.stringify({ private: true, dependencies: { 'proper-lockfile': '4.1.2' } }));
    execFileSync('npm', ['install', '--prefix', runtimeDeps, '--offline', '--legacy-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund'], {
      timeout: 60_000, stdio: 'pipe',
    });
    await symlink(join(runtimeDeps, 'node_modules'), join(installedPackage, 'node_modules'), 'dir');
    const installedLockfile = join(installedPackage, 'node_modules/proper-lockfile/package.json');
    assert.equal(JSON.parse(await readFile(installedLockfile, 'utf8')).version, '4.1.2');
    const scope = join(installedPackage, 'node_modules/@earendil-works');
    await mkdir(scope, { recursive: true });
    const hostNodeModules = resolve(root, '../../../node_modules');
    for (const name of ['pi-coding-agent', 'pi-ai', 'pi-tui']) {
      await symlink(join(hostNodeModules, '@earendil-works', name), join(scope, name), 'dir');
    }
    await mkdir(join(installedPackage, 'node_modules/@pi'), { recursive: true });
    await symlink(join(repoRoot, 'packages/project-metrics'), join(installedPackage, 'node_modules/@pi/project-metrics'), 'dir');

    const importHost = async (relativePath: string) => import(pathToFileURL(join(root, relativePath)).href);
    const importHostPackage = async (name: string, relativePath: string) => import(pathToFileURL(join(hostNodeModules, '@earendil-works', name, relativePath)).href);
    const [{ discoverAndLoadExtensions }, { createEventBus }, { ExtensionRunner }, piTui, piAi] = await Promise.all([
      importHost('dist/core/extensions/loader.js'),
      importHost('dist/core/event-bus.js'),
      importHost('dist/core/extensions/runner.js'),
      importHostPackage('pi-tui', 'dist/index.js'),
      importHostPackage('pi-ai', 'dist/index.js'),
    ]);

    const events = createEventBus();
    const legacyEvents: unknown[] = [];
    events.on('@pi/codex-usage-status:fast-requested/v1', (data: unknown) => legacyEvents.push(data));
    const loaded = await discoverAndLoadExtensions([installedPackage], tempDir, tempDir, events);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1, 'package manifest entry is loaded by Pi native extension loader');

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
    const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, tempDir, {
      getSessionId: () => `pi-${expectedHostVersion}-compat-session`,
      getSessionFile: () => join(tempDir, 'session.jsonl'),
      getCwd: () => tempDir,
    }, {
      isUsingOAuth: () => true,
      getProviderAuth: async () => { throw new Error('No auth lookup expected in this compatibility test'); },
    });
    const errors: unknown[] = [];
    runner.onError((error: unknown) => errors.push(error));
    runner.bindCore(new Proxy({}, { get: () => () => undefined }), {
      getModel: () => model, getScopedModels: () => [], isIdle: () => true,
      isProjectTrusted: () => true, getSignal: () => new AbortController().signal,
      abort: () => {}, hasPendingMessages: () => false, shutdown: () => {},
      getContextUsage: () => undefined, compact: () => {}, getSystemPrompt: () => '',
    });
    runner.setUIContext(ui as never, 'tui');

    for (const eventName of ['session_start', 'input', 'model_select', 'agent_settled', 'before_provider_request', 'message_end', 'session_shutdown']) {
      assert.equal(runner.hasHandlers(eventName), true, `Pi recognizes registered ${eventName} handler`);
    }
    assert.ok(runner.getCommand('fast'), 'Fast slash command registered through ExtensionAPI');
    await runner.emit({ type: 'session_start', reason: 'new' });
    await runner.getCommand('fast')!.handler('on', runner.createCommandContext());
    assert.deepEqual(await runner.emitBeforeProviderRequest({ model: 'gpt-5.4', input: [] }), {
      model: 'gpt-5.4', input: [], service_tier: 'priority',
    }, 'the real runner applies Fast machine preference as priority request intent');
    assert.deepEqual(JSON.parse(await readFile(join(tempDir, 'settings.json'), 'utf8')).myPiExtensions, { fast: true }, 'Fast On persists the machine preference');

    await writeFile(join(tempDir, 'settings.json'), JSON.stringify({ myPiExtensions: { fast: false } }));
    await runner.emit({ type: 'input', text: 'refresh-off' });
    assert.deepEqual(await runner.emitBeforeProviderRequest({ model: 'gpt-5.4', input: [] }), {
      model: 'gpt-5.4', input: [],
    }, 'input refresh observes another host changing the machine preference Off');
    await writeFile(join(tempDir, 'settings.json'), JSON.stringify({ myPiExtensions: { fast: true } }));
    await runner.emit({ type: 'input', text: 'refresh-on' });
    assert.deepEqual(await runner.emitBeforeProviderRequest({ model: 'gpt-5.4', input: [] }), {
      model: 'gpt-5.4', input: [], service_tier: 'priority',
    }, 'input refresh observes another host changing the machine preference On');

    assert.ok(uiCalls.some(({ method }) => method === 'setStatus'), 'real runner context exposes the status UI contract');
    const widgetCall = uiCalls.find(({ method, args }) => method === 'setWidget' && args[0] === 'codex-usage-status' && args[2] !== undefined);
    assert.ok(widgetCall, 'extension uses the native widget contract');
    assert.equal(typeof widgetCall.args[1], 'function', 'widget content is a Pi component factory');
    assert.deepEqual(widgetCall.args[2], { placement: 'belowEditor' });
    const component = (widgetCall.args[1] as (tui: unknown, theme: unknown) => { render(width: number): string[] })(undefined, undefined);
    const rendered = component.render(10);
    assert.equal(rendered.length, 1);
    assert.equal(rendered[0], piTui.truncateToWidth('\u001b[38;2;217;140;63m⚡ Fast\u001b[0m · Codex: unavailable', 10, ''), 'widget rendering follows the host TUI contract');

    await runner.emit({ type: 'session_shutdown', reason: 'quit' });
    assert.deepEqual(legacyEvents, [], 'machine preference does not publish the retired session-scoped Fast event');
    assert.deepEqual(JSON.parse(await readFile(join(tempDir, 'settings.json'), 'utf8')).myPiExtensions, { fast: true }, 'session shutdown does not switch off the machine preference');
    assert.ok(uiCalls.some(({ method, args }) => method === 'setWidget' && args[0] === 'codex-usage-status' && args[1] === undefined), 'shutdown clears the widget');
    assert.deepEqual(errors, [], 'native runner reports no lifecycle errors');

    const nativeCost = piAi.calculateCost(model, {
      input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000,
      totalTokens: 4_000_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    assert.deepEqual(nativeCost, { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 3, total: 6.5 }, 'Fast cost correction dependency retains its native cost contract');
    const peerVersions = await Promise.all(['@earendil-works/pi-ai', '@earendil-works/pi-tui'].map(async (name) => {
      const manifestPath = join(hostNodeModules, name, 'package.json');
      return (JSON.parse(await readFile(manifestPath, 'utf8')) as { version: string }).version;
    }));
    assert.deepEqual(peerVersions, [expectedHostVersion, expectedHostVersion], 'host-provided extension peers match the selected Pi host');
  });
}
