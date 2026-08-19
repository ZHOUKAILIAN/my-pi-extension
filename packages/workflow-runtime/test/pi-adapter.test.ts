import test from 'node:test';
import assert from 'node:assert/strict';
import { PiSdkWorkerExecutor } from '../src/index.ts';

test('PiSdk adapter uses an isolated SDK session and captures submit_artifact', async () => {
  let options: any;
  const resourceLoader: any = { reload: async () => {} };
  const executor = new PiSdkWorkerExecutor({
    resourceLoader,
    createSession: async (request: any) => {
      options = request;
      return {
        session: {
          prompt: async () => {
            const tool = request.customTools.find((item: any) => item.name === 'submit_artifact');
            await tool.execute('call-1', { kind: 'investigation', route: 'local_fix', evidence: ['trace'] });
          },
        },
      };
    },
  });
  const result = await executor.execute({ id: 'n', profile: { tools: ['read'] } }, 'task', {});
  assert.deepEqual(options.tools, ['read']);
  assert.equal(options.sessionManager.constructor.name, 'SessionManager');
  assert.equal(options.resourceLoader, resourceLoader);
  assert.equal(options.customTools[0].name, 'submit_artifact');
  assert.equal(result.kind, 'investigation');
});

test('PiSdk adapter rejects a session that does not submit an artifact', async () => {
  const executor = new PiSdkWorkerExecutor({
    resourceLoader: { reload: async () => {} } as any,
    createSession: async () => ({ session: { prompt: async () => {} } }) as any,
  });
  await assert.rejects(() => executor.execute({ id: 'n', profile: { tools: [] } }, '', {}), /did not submit artifact/);
});
