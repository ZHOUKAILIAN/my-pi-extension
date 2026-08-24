import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension from '../src/extension.ts';

function harness(entries: any[], confirm = true, options: { cwd?: string; trusted?: boolean } = {}) {
  let onStart: any;
  let calls = 0;
  let confirmCalls = 0;
  const results: any[] = [
    { kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['ok'] },
    { kind: 'implementation', artifact: { summary: 'patch', filesChanged: ['a.ts'], candidateRevision: 'rev-1' } },
    { kind: 'verification', accepted: true, evidence: ['ok'], candidateRevision: 'rev-1' },
  ];
  const pi: any = {
    on: (_event: string, handler: any) => { onStart = handler; },
    fixWorker: { execute: async () => results[calls++] },
    appendEntry: (customType: string, data: any) => entries.push({ customType, data }),
    registerCommand: () => {},
  };
  const ctx: any = { cwd: options.cwd ?? mkdtempSync(join(tmpdir(), 'fix-test-cwd-')), hasUI: true, thinkingLevel: 'high', isProjectTrusted: () => options.trusted ?? true,
    sessionManager: { getEntries: () => entries }, ui: { confirm: async () => { confirmCalls += 1; return confirm; }, notify: () => {} } };
  extension(pi);
  return { start: (reason: string) => onStart({ reason }, ctx), calls: () => calls, confirmCalls: () => confirmCalls };
}
const cp = (stage: any, runId = 'fix-r', problem = '登录后白屏') => ({ customType: 'workflow-run', data: { runId, stage, problem, id: stage, at: 1 } });

test('only Pi session resume can continue an unfinished workflow', async () => {
  const h = harness([cp('BLOCKED')]);
  for (const reason of ['startup', 'reload', 'new', 'fork']) await h.start(reason);
  assert.equal(h.calls(), 0);
});

test('resume asks only for an uncompleted run and continues on confirmation', async () => {
  const declined = harness([cp('BLOCKED')], false);
  await declined.start('resume');
  assert.equal(declined.calls(), 0);
  const accepted = harness([
    { customType: 'workflow-command', data: { operation: 'start' } },
    { customType: 'workflow-model-policy', data: { runId: 'other', nodeId: 'investigate' } },
    cp('INVESTIGATING'),
  ], true);
  await accepted.start('resume');
  assert.equal(accepted.calls(), 3);
});

test('accepted run does not confirm or invoke worker', async () => {
  const h = harness([cp('ACCEPTED')]);
  await h.start('resume');
  assert.equal(h.calls(), 0);
});

test('resuming a waiting workflow uses the session confirmation as its decision', async () => {
  const waiting = cp('WAITING_FOR_USER');
  waiting.data.pendingDecisionRequest = 'waiting-request';
  const h = harness([waiting]);
  await h.start('resume');
  assert.equal(h.confirmCalls(), 1);
  assert.equal(h.calls(), 3);
});

test('untrusted project ignores its model policy during session resume', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fix-untrusted-'));
  mkdirSync(join(cwd, '.pi'));
  writeFileSync(join(cwd, '.pi', 'workflow-models.json'), JSON.stringify({ version: 1, default: 'inherit' }));
  const entries = [cp('INVESTIGATING')];
  const h = harness(entries, true, { cwd, trusted: false });
  await h.start('resume');
  assert.equal(h.calls(), 3);
  assert.equal(entries.find((entry) => entry.customType === 'workflow-model-policy')?.data.source, 'runtime-default');
});
