import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const expected = [
  'packages/fix/src/extension.ts',
  'packages/codex-usage-status/src/index.ts',
  'packages/subagent/src/index.ts',
];

test('Git release manifest exposes only the three daily extensions', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.version, '0.1.0');
  assert.deepEqual(manifest.pi.extensions, expected);
  for (const entry of expected) await readFile(join(root, entry));
  const fix = JSON.parse(await readFile(join(root, 'packages/fix/package.json'), 'utf8'));
  assert.equal(fix.dependencies['@earendil-works/pi-tui'], undefined);
  assert.equal(fix.peerDependencies['@earendil-works/pi-tui'], '*');
});

const host = process.env.PI_CODING_AGENT_1_0_4_PATH;
test('production-only Git installation loads all three extensions in real Pi 1.0.4', {
  skip: !host && 'Set PI_CODING_AGENT_1_0_4_PATH for the release host smoke test',
  timeout: 120_000,
}, async (t) => {
  assert.equal(JSON.parse(await readFile(join(host!, 'package.json'), 'utf8')).version, '1.0.4');
  const temp = await mkdtemp(join(tmpdir(), 'pi-release-install-'));
  const agentDir = join(temp, 'agent');
  const installed = join(temp, 'installed');
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousMetrics = process.env.PI_METRICS_CONFIG;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_METRICS_CONFIG;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousMetrics === undefined) delete process.env.PI_METRICS_CONFIG;
    else process.env.PI_METRICS_CONFIG = previousMetrics;
    await rm(temp, { recursive: true, force: true });
  });
  await mkdir(installed, { recursive: true });
  await mkdir(agentDir);
  for (const name of ['package.json', 'package-lock.json']) await cp(join(root, name), join(installed, name));
  for (const name of await readdir(join(root, 'packages'))) {
    const target = join(installed, 'packages', name);
    await mkdir(target, { recursive: true });
    await cp(join(root, 'packages', name, 'package.json'), join(target, 'package.json'));
    await cp(join(root, 'packages', name, 'src'), join(target, 'src'), { recursive: true });
  }
  // Match Pi's managed Git dependency installation, without running package scripts.
  execFileSync('npm', ['ci', '--omit=dev', '--legacy-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: installed, timeout: 90_000, stdio: 'pipe',
  });
  const productionModules = await readdir(join(installed, 'node_modules'));
  assert.equal(productionModules.includes('@earendil-works'), false, 'host SDK/TUI must not be bundled into the installation');
  assert.equal(productionModules.includes('typescript'), false, 'development tooling is not needed for loading');

  const importHost = (path: string) => import(pathToFileURL(join(host!, path)).href);
  const [{ discoverAndLoadExtensions }, { ExtensionRunner }, { createEventBus }] = await Promise.all([
    importHost('dist/core/extensions/loader.js'),
    importHost('dist/core/extensions/runner.js'),
    importHost('dist/core/event-bus.js'),
  ]);
  const loaded = await discoverAndLoadExtensions([installed], temp, agentDir, createEventBus());
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.extensions.map((extension: { path: string }) => extension.path).sort(), expected.map(path => join(installed, path)).sort());
  const commands = loaded.extensions.flatMap((extension: { commands: Map<string, unknown> }) => [...extension.commands.keys()]);
  assert.deepEqual(commands.sort(), ['fast', 'fix']);
  assert.deepEqual(loaded.extensions.flatMap((extension: { tools: Map<string, unknown> }) => [...extension.tools.keys()]), ['subagent']);
  assert.equal(commands.includes('async-compact'), false);

  const notices: string[] = [];
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, temp, {
    getSessionId: () => 'release-smoke', getSessionFile: () => undefined,
    getCwd: () => temp, getLeafId: () => null, getBranch: () => [],
  }, { isUsingOAuth: () => false });
  const errors: unknown[] = [];
  runner.onError((error: unknown) => errors.push(error));
  runner.bindCore(new Proxy({}, { get: () => () => undefined }), {
    getModel: () => undefined, getScopedModels: () => [], isIdle: () => true,
    isProjectTrusted: () => true, getSignal: () => new AbortController().signal,
    hasPendingMessages: () => false, getContextUsage: () => undefined,
    abort: () => {}, shutdown: () => {}, compact: () => {}, getSystemPrompt: () => '',
  });
  runner.setUIContext({
    notify: (text: string) => notices.push(text), setStatus: () => {}, setWidget: () => {},
  }, 'tui');
  await runner.emit({ type: 'session_start', reason: 'new' });
  await runner.getCommand('fix')!.handler('', runner.createCommandContext());
  assert.ok(notices.some(text => text.includes('/fix')), 'empty /fix returns usage instead of starting a Worker');
  assert.equal((await runner.emit({ type: 'session_before_tree' }))?.cancel, false, 'no Worker means navigation is not blocked');
  await runner.emit({ type: 'session_shutdown', reason: 'quit' });
  assert.deepEqual(errors, [], 'native runner must not swallow lifecycle failures');
});
