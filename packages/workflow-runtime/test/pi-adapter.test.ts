import test from 'node:test';
import assert from 'node:assert/strict';
import { PiSdkWorkerExecutor } from '../src/index.ts';

test('PiSdk adapter injects only the node skills into a new session', async () => {
  let options: any;
  const skills = [
    { name: 'cst-plus', description: 'CST', filePath: '/skills/cst-plus/SKILL.md', baseDir: '/skills/cst-plus', sourceInfo: {}, disableModelInvocation: false },
    { name: 'tdd', description: 'TDD', filePath: '/skills/tdd/SKILL.md', baseDir: '/skills/tdd', sourceInfo: {}, disableModelInvocation: false },
  ];
  const resourceLoader: any = {
    reload: async () => {},
    getSkills: () => ({ skills, diagnostics: [] }),
  };
  const executor = new PiSdkWorkerExecutor({
    skills: ['cst-plus'],
    model: { provider: 'p', id: 'm' },
    resourceLoader,
    createSession: async (request: any) => {
      options = request;
      return { session: { prompt: async () => {
        const tool = request.customTools.find((item: any) => item.name === 'submit_artifact');
        await tool.execute('call-1', { kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'] });
      } } };
    },
  });
  await executor.execute({ id: 'n', profile: { tools: ['read'], skills: ['cst-plus'] } }, 'task', {});
  assert.deepEqual(options.resourceLoader.getSkills().skills.map((skill: any) => skill.name), ['cst-plus']);
});

test('PiSdk adapter scopes a real Pi ResourceLoader before creating the session', async () => {
  let options: any;
  const executor = new PiSdkWorkerExecutor({
    cwd: process.cwd(),
    skills: ['cst-plus'],
    model: { provider: 'p', id: 'm' },
    createSession: async (request: any) => {
      options = request;
      return { session: { prompt: async () => {
        const tool = request.customTools.find((item: any) => item.name === 'submit_artifact');
        await tool.execute('call-1', { kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'] });
      } } };
    },
  });
  await executor.execute({ id: 'n', profile: { tools: ['read'], skills: ['cst-plus'] } }, 'task', {});
  assert.deepEqual(options.resourceLoader.getSkills().skills.map((skill: any) => skill.name), ['cst-plus']);
  assert.equal(options.resourceLoader.getSkills().skills[0].filePath.includes('cst-plus'), true);
});

test('PiSdk adapter rejects an unknown configured skill before session creation', async () => {
  let created = false;
  const executor = new PiSdkWorkerExecutor({
    skills: ['missing-skill'],
    resourceLoader: { reload: async () => {}, getSkills: () => ({ skills: [], diagnostics: [] }) } as any,
    createSession: async () => { created = true; return { session: { prompt: async () => {} } } as any; },
  });
  await assert.rejects(() => executor.execute({ id: 'n', profile: { tools: [] } }, '', {}), /unknown node skill/);
  assert.equal(created, false);
});

test('PiSdk adapter uses an isolated SDK session and captures submit_artifact', async () => {
  let options: any;
  const resourceLoader: any = { reload: async () => {}, getSkills: () => ({ skills: [], diagnostics: [] }) };
  const executor = new PiSdkWorkerExecutor({
    thinkingLevel: 'high',
    resourceLoader,
    createSession: async (request: any) => {
      options = request;
      return {
        session: {
          prompt: async () => {
            const tool = request.customTools.find((item: any) => item.name === 'submit_artifact');
            await tool.execute('call-1', { kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'] });
          },
        },
      };
    },
  });
  const result = await executor.execute({ id: 'n', profile: { tools: ['read'] } }, 'task', {});
  assert.deepEqual(options.tools, ['read']);
  assert.equal(options.sessionManager.constructor.name, 'SessionManager');
  assert.notEqual(options.resourceLoader, resourceLoader);
  assert.deepEqual(options.resourceLoader.getSkills().skills, []);
  await options.resourceLoader.reload();
  assert.equal(options.thinkingLevel, 'high');
  assert.equal(options.customTools[0].name, 'submit_artifact');
  assert.equal(result.kind, 'investigation');
});

test('PiSdk adapter includes the node artifact contract and retries once after plain text', async () => {
  const prompts: string[] = [];
  let attempts = 0;
  const executor = new PiSdkWorkerExecutor({
    resourceLoader: { reload: async () => {}, getSkills: () => ({ skills: [], diagnostics: [] }) } as any,
    createSession: async (request: any) => ({ session: { prompt: async (value: string) => {
      prompts.push(value);
      attempts += 1;
      if (attempts === 2) {
        const tool = request.customTools.find((item: any) => item.name === 'submit_artifact');
        await tool.execute('call-2', { kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'] });
      }
    } } }) as any,
  });
  const result = await executor.execute({ id: 'investigate', profile: { tools: [] } }, 'white screen', { userId: 'u-1' });
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /Call submit_artifact exactly once/);
  assert.match(prompts[0], /white screen/);
  assert.match(prompts[0], /userId/);
  assert.match(prompts[1], /previous response did not call submit_artifact/);
  assert.equal(result.kind, 'investigation');
});

test('PiSdk adapter accepts only a validated structured-text artifact when the model omits the tool call', async () => {
  let prompts = 0;
  let fallback: any;
  const executor = new PiSdkWorkerExecutor({
    onProgress: (progress) => { if (progress.type === 'artifact_fallback') fallback = progress.artifact; },
    resourceLoader: { reload: async () => {}, getSkills: () => ({ skills: [], diagnostics: [] }) } as any,
    createSession: async () => ({
      session: {
        prompt: async () => { prompts += 1; },
        messages: [{ role: 'assistant', content: [{ type: 'text', text: '```bugfix-artifact\n{"kind":"investigation","route":"local_fix","rootCause":"cause","evidence":["trace"]}\n```' }] }],
      },
    }) as any,
  });
  const result = await executor.execute({ id: 'investigate', profile: { tools: [] } }, '', {});
  assert.equal(prompts, 1);
  assert.deepEqual(result, fallback);
});

test('PiSdk adapter rejects a session that does not submit an artifact after retry', async () => {
  let prompts = 0;
  const executor = new PiSdkWorkerExecutor({
    resourceLoader: { reload: async () => {}, getSkills: () => ({ skills: [], diagnostics: [] }) } as any,
    createSession: async () => ({ session: { prompt: async () => { prompts += 1; } } }) as any,
  });
  await assert.rejects(() => executor.execute({ id: 'investigate', profile: { tools: [] } }, '', {}), /did not produce a valid artifact/);
  assert.equal(prompts, 2);
});
