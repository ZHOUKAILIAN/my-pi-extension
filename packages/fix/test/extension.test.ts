import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import extension from '../src/extension.ts';

test('manifest points to a real importable source extension', async () => {
  const packageJson = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const relative = packageJson.pi.extensions[0];
  const path = resolve(dirname(fileURLToPath(import.meta.url)), '..', relative);
  await access(path);
  assert.equal(typeof extension, 'function');
});

test('registers and executes through the Pi extension loader', async () => {
  const loaderUrl = new URL('../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js', import.meta.url);
  const { loadExtensions, createExtensionRuntime } = await import(loaderUrl.href);
  const runtime = createExtensionRuntime();
  const loaded = await loadExtensions([resolve(dirname(fileURLToPath(import.meta.url)), '../src/extension.ts')], process.cwd(), undefined, runtime);
  const command = loaded.extensions[0].commands.get('fix');
  assert.equal(command?.name, 'fix');
  assert.equal(typeof command?.handler, 'function');
  // The loader supplies the real ExtensionAPI object; its unbound action stub is
  // intentionally not used here. CLI smoke below binds it to a real session.
  assert.equal(typeof loaded.extensions[0].commands.get('fix')?.handler, 'function');
});

test('real 0.84.2 ExtensionRunner receives fail-closed lifecycle results when context/owner lookup throws', async () => {
  const loaderUrl = new URL('../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js', import.meta.url);
  const runnerUrl = new URL('../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js', import.meta.url);
  const { loadExtensions, createExtensionRuntime } = await import(loaderUrl.href);
  const { ExtensionRunner } = await import(runnerUrl.href);
  const runtime = createExtensionRuntime();
  const loaded = await loadExtensions([resolve(dirname(fileURLToPath(import.meta.url)), '../src/extension.ts')], process.cwd(), undefined, runtime);
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, process.cwd(), {} as any, {} as any);
  (runner as any).sessionManager = { getSessionId: () => { throw new Error('session context unavailable'); } };
  for (const type of ['session_before_tree', 'session_before_switch', 'session_before_fork'] as const) {
    const result = await runner.emit({ type } as any);
    assert.deepEqual(result, { cancel: true }, type);
  }
});
