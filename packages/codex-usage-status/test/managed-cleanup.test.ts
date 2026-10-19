import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagedExtensionFactory } from '../src/index.ts';

function fakePi() {
  const handlers = new Map<string, Function[]>();
  return {
    handlers,
    registerCommand() {},
    on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  } as any;
}

test('managed Fast factory owns real usage/metric cleanup and is idempotent', async () => {
  const factory = createManagedExtensionFactory({ settingsFile: '/tmp/synthetic-fast-settings.json', agentType: 'subagent' }) as any;
  const pi = fakePi();
  await factory(pi);
  assert.equal(typeof factory.managedShutdown, 'function');
  await factory.managedShutdown(performance.now() + 1000);
  await factory.managedShutdown(performance.now() + 1000);
  assert.ok(pi.handlers.get('session_shutdown'));
});
