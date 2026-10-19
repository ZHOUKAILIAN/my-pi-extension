import test from 'node:test';
import assert from 'node:assert/strict';
import { loadMachineExtensionsBundle, ManagedOwnershipTracker, ManagedSessionRuntime } from '../src/machine-extensions.ts';

test('managed bundle closes the real factory resource, not only the wrapper flag', async () => {
  let started = 0;
  let closed = 0;
  const factory = Object.assign(async () => { started++; }, {
    managedShutdown: async () => { closed++; },
  });
  const loaded = await loadMachineExtensionsBundle({ settingsFile: '/tmp/synthetic-settings.json', agentType: 'subagent' }, {
    bundle: {
      version: 1,
      create: () => ({
        extensions: [{ name: 'real', factory }],
        capabilities: [{ capability: 'fast', status: 'active', reason: 'available' }],
        shutdown: async () => {},
      }),
    },
  });
  await loaded.extensions[0].factory({} as never);
  assert.equal(started, 1);
  assert.equal(loaded.handles?.[0].started, true);
  await loaded.shutdown(performance.now() + 1000);
  assert.equal(closed, 1);
  assert.equal(loaded.handles?.[0].invalid, true);
  await loaded.shutdown(performance.now() + 1000);
  assert.equal(closed, 1);
});

test('session lifecycle observes start, reload replacement and quit through public seams', async () => {
  const events: string[] = [];
  const runners = [
    { emit: async (event: any) => { events.push(`a:${event.type}`); } },
    { emit: async (event: any) => { events.push(`b:${event.type}`); } },
  ];
  let current = runners[0];
  const session: any = {
    get extensionRunner() { return current; },
    async bindExtensions() { await current.emit({ type: 'session_start', reason: 'startup' }); },
    async reload(options: any) {
      await current.emit({ type: 'session_shutdown', reason: 'reload' });
      current = runners[1];
      await options?.beforeSessionStart?.();
      await current.emit({ type: 'session_start', reason: 'reload' });
    },
  };
  const runtime = new ManagedSessionRuntime(() => events.push('error'));
  await runtime.bind(session);
  await session.reload();
  await runtime.emitShutdown(session, performance.now() + 1000);
  assert.deepEqual(events, ['a:session_start', 'a:session_shutdown', 'b:session_start', 'b:session_shutdown']);
  assert.equal(events.filter(event => event === 'a:session_shutdown').length, 1);
  assert.equal(events.filter(event => event === 'b:session_shutdown').length, 1);
});

test('a replacement runner that never starts is not sent a synthetic quit', async () => {
  const events: string[] = [];
  const oldRunner = { emit: async (event: any) => { events.push(`old:${event.type}`); } };
  const newRunner = { emit: async (event: any) => { events.push(`new:${event.type}`); } };
  let current = oldRunner;
  const session: any = {
    get extensionRunner() { return current; },
    async bindExtensions() { await current.emit({ type: 'session_start', reason: 'startup' }); },
    async reload(options: any) {
      await current.emit({ type: 'session_shutdown', reason: 'reload' });
      current = newRunner;
      await options.beforeSessionStart();
      throw new Error('loader failed after replacement construction');
    },
  };
  const runtime = new ManagedSessionRuntime();
  await runtime.bind(session);
  await assert.rejects(() => session.reload(), /loader failed/);
  await runtime.emitShutdown(session);
  assert.deepEqual(events, ['old:session_start', 'old:session_shutdown']);
});

test('foreign resources are rejected without invalidating either owner', () => {
  const tracker = new ManagedOwnershipTracker<{ invalidateCount: number }>();
  const a = tracker.own({ invalidateCount: 0 });
  const b = { invalidateCount: 0 };
  assert.throws(() => tracker.adopt(a, b), /foreign_managed_resource/);
  tracker.invalidateAll(resource => { resource.invalidateCount++; });
  assert.equal(a.invalidateCount, 1);
  assert.equal(b.invalidateCount, 0);
});
