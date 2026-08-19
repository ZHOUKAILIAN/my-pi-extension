import test from 'node:test';
import assert from 'node:assert/strict';
import extension from '../src/extension.ts';
import type { Artifact } from '@pi/workflow-contracts';

function harness(answers: Artifact[], initial: any[] = []) {
  const entries = initial;
  let command: any;
  let calls = 0;
  const notifications: string[] = [];
  const pi: any = {
    bugFixWorker: { execute: async () => answers[calls++] },
    registerCommand: (_: string, value: any) => { command = value.handler; },
    appendEntry: (_: string, data: any) => entries.push({ customType: 'workflow-run', data }),
  };
  const ctx: any = { sessionManager: { getEntries: () => entries }, ui: { notify: (v: string) => notifications.push(v) } };
  extension(pi);
  return { command, ctx, entries, notifications, calls: () => calls };
}

test('command-level BLOCKED is unlocked by new investigation evidence', async () => {
  const h = harness([{ kind: 'investigation', route: 'local_fix', evidence: ['new evidence'] }, { kind: 'implementation', artifact: 'patch' }, { kind: 'verification', accepted: true, evidence: ['pass'] }], [
    { customType: 'workflow-run', data: { runId: 'blocked-1', stage: 'BLOCKED', at: 1, id: 'old' } },
  ]);
  await h.command('resume runId=blocked-1', h.ctx);
  assert.equal(h.calls(), 3);
  assert.equal(h.entries.at(-1).data.stage, 'ACCEPTED');
});

test('command decision rejects mismatch and consumes the matching request', async () => {
  const initial = [{ customType: 'workflow-run', data: { runId: 'decision-1', stage: 'WAITING_FOR_USER', at: 1, id: 'wait', pendingDecisionRequest: 'decision-1:req' } }];
  const h = harness([], initial);
  await h.command('decision runId=decision-1 requestId=wrong', h.ctx);
  assert.match(h.notifications.at(-1), /invalid/);
  assert.equal(h.entries.length, 1);
  await h.command('decision runId=decision-1 requestId=decision-1:req', h.ctx);
  assert.equal(h.entries.at(-1).data.stage, 'INVESTIGATING');
  const count = h.entries.length;
  await h.command('decision runId=decision-1 requestId=decision-1:req', h.ctx);
  assert.equal(h.entries.length, count);
});
