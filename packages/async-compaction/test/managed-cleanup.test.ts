import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagedExtensionFactory } from '../src/index.ts';

function fakePi() {
  const handlers = new Map<string, Function[]>();
  return {
    handlers,
    registerCommand() {},
    registerEntryRenderer() {},
    appendEntry() {},
    on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    getSettings() { return { compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 1 } }; },
    getAllTools() { return []; },
    getActiveTools() { return []; },
  } as any;
}

test('managed Async factory owns a real controller/timing cleanup generation', async () => {
  const factory = createManagedExtensionFactory({ settingsFile: '/tmp/synthetic-async-settings.json', agentType: 'subagent' }) as any;
  const pi = fakePi();
  await factory(pi);
  assert.equal(typeof factory.managedShutdown, 'function');
  await factory.managedShutdown(performance.now() + 1000);
  await factory.managedShutdown(performance.now() + 1000);
  assert.ok(pi.handlers.get('session_shutdown'));
});
