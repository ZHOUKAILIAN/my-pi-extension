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
    { kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'] },
    { kind: 'implementation', artifact: { summary: 'patch', filesChanged: ['a.ts'], candidateRevision: 'rev-1' } },
    { kind: 'verification', accepted: true, evidence: ['tests'], candidateRevision: 'rev-1' },
  ];
  let calls = 0;
  const worker = { execute: async () => answers[calls++] } as any;
  let command: any;
  const traces: any[] = [];
  const pi: any = {
    fixWorker: worker,
    registerCommand: (_name: string, value: any) => { command = value.handler; },
    registerMessageRenderer() {},
    sendMessage: (message: any) => traces.push(message),
    appendEntry: (customType: string, data: any) => entries.push({ customType, data }),
  };
  const ctx: any = { cwd: mkdtempSync(join(tmpdir(), 'fix-test-cwd-')), sessionManager: { getEntries: () => entries }, ui: { notify() {} } };
  extension(pi);
  await command('登录后白屏', ctx);
  assert.equal(calls, 3);
  assert.equal(entries.filter((entry) => entry.data.stage).map((entry) => entry.data.stage).join(','), 'INVESTIGATING,IMPLEMENTING,VERIFYING,ACCEPTED');
  assert.equal(traces.some((entry) => entry.content.includes('INVESTIGATING')), true);
  assert.equal(entries.some((entry) => entry.customType === 'workflow-trace' && entry.data.content.includes('INVESTIGATING')), true);

  const retryEntries: any[] = [];
  const retryAnswers: Artifact[] = [
    { kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'] },
    { kind: 'implementation', artifact: { summary: 'patch-1', filesChanged: ['a.ts'], candidateRevision: 'rev-1' } },
    { kind: 'verification', accepted: false, evidence: ['failed'], candidateRevision: 'rev-1' },
    { kind: 'implementation', artifact: { summary: 'patch-2', filesChanged: ['a.ts'], candidateRevision: 'rev-2' } },
    { kind: 'verification', accepted: true, evidence: ['passed'], candidateRevision: 'rev-2' },
  ];
  let retryCalls = 0;
  const retryPi: any = {
    fixWorker: { execute: async () => retryAnswers[retryCalls++] },
    registerCommand: (_name: string, value: any) => { command = value.handler; },
    appendEntry: (customType: string, data: any) => retryEntries.push({ customType, data }),
  };
  const retryCtx: any = { cwd: mkdtempSync(join(tmpdir(), 'fix-test-cwd-')), sessionManager: { getEntries: () => retryEntries }, ui: { notify() {} } };
  extension(retryPi);
  await command('登录后白屏', retryCtx);
  assert.equal(retryCalls, 5);
  const retryCheckpoints = retryEntries.filter((entry) => entry.customType === 'workflow-run');
  assert.equal(retryCheckpoints.at(-3).data.stage, 'IMPLEMENTING');
  assert.equal(retryCheckpoints.at(-1).data.stage, 'ACCEPTED');
});
