import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension from '../src/extension.ts';
import type { Artifact } from '@pi/workflow-contracts';

test('command handler runs injected worker through all stages and checkpoints', async () => {
  const entries: any[] = [];
  const answers: Artifact[] = [
    { kind: 'investigation', route: 'local_fix', evidence: ['trace'] },
    { kind: 'implementation', artifact: 'patch' },
    { kind: 'verification', accepted: true, evidence: ['tests'] },
  ];
  let calls = 0;
  const worker = { execute: async () => answers[calls++] } as any;
  let command: any;
  const traces: any[] = [];
  const pi: any = {
    bugFixWorker: worker,
    registerCommand: (_name: string, value: any) => { command = value.handler; },
    registerMessageRenderer() {},
    sendMessage: (message: any) => traces.push(message),
    appendEntry: (_type: string, data: any) => entries.push({ customType: 'workflow-run', data }),
  };
  const ctx: any = { cwd: mkdtempSync(join(tmpdir(), 'bugfix-test-cwd-')), sessionManager: { getEntries: () => entries }, ui: { notify() {} } };
  extension(pi);
  await command('登录后白屏', ctx);
  assert.equal(calls, 3);
  assert.equal(entries.filter((entry) => entry.data.stage).map((entry) => entry.data.stage).join(','), 'INVESTIGATING,IMPLEMENTING,VERIFYING,ACCEPTED');
  assert.equal(traces.some((entry) => entry.content.includes('INVESTIGATING')), true);

  const retryEntries: any[] = [];
  const retryAnswers: Artifact[] = [
    { kind: 'investigation', route: 'local_fix', evidence: ['trace'] },
    { kind: 'implementation', artifact: 'patch-1' },
    { kind: 'verification', accepted: false, evidence: ['failed'] },
    { kind: 'implementation', artifact: 'patch-2' },
    { kind: 'verification', accepted: true, evidence: ['passed'] },
  ];
  let retryCalls = 0;
  const retryPi: any = {
    bugFixWorker: { execute: async () => retryAnswers[retryCalls++] },
    registerCommand: (_name: string, value: any) => { command = value.handler; },
    appendEntry: (_type: string, data: any) => retryEntries.push({ customType: 'workflow-run', data }),
  };
  const retryCtx: any = { cwd: mkdtempSync(join(tmpdir(), 'bugfix-test-cwd-')), sessionManager: { getEntries: () => retryEntries }, ui: { notify() {} } };
  extension(retryPi);
  await command('登录后白屏', retryCtx);
  assert.equal(retryCalls, 5);
  assert.equal(retryEntries.at(-3).data.stage, 'IMPLEMENTING');
  assert.equal(retryEntries.at(-1).data.stage, 'ACCEPTED');
});
