import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension from '../src/extension.ts';
import type { Artifact } from '@pi/workflow-contracts';

function harness(answers: Artifact[], initial: any[] = [], input?: string) {
  const entries = initial;
  let command: any;
  let calls = 0;
  const capsules: any[] = [];
  const notifications: string[] = [];
  const pi: any = {
    bugFixWorker: { execute: async (_node: any, _task: any, capsule: any) => { capsules.push(capsule); return answers[calls++]; } },
    registerCommand: (_name: string, value: any) => { command = value.handler; },
    appendEntry: (customType: string, data: any) => entries.push({ customType, data }),
  };
  const ctx: any = { cwd: mkdtempSync(join(tmpdir(), 'bugfix-test-cwd-')), sessionManager: { getEntries: () => entries }, hasUI: true,
    ui: { notify: (v: string) => notifications.push(v), input: async () => input } };
  extension(pi);
  return { command, ctx, entries, notifications, capsules, calls: () => calls };
}

const blocked = { customType: 'workflow-run', data: { runId: 'blocked-1', stage: 'INVESTIGATING', at: 1, id: 'old', problem: '登录后白屏' } };

test('current BLOCKED command collects one supplement and reaches ACCEPTED', async () => {
  const h = harness([
    { kind: 'investigation', route: 'needs_more_evidence', evidence: ['not enough'] },
    { kind: 'investigation', route: 'local_fix', evidence: ['new evidence'] },
    { kind: 'implementation', artifact: 'patch' },
    { kind: 'verification', accepted: true, evidence: ['pass'] },
  ], [blocked], '补充信息');
  await h.command('登录后白屏', h.ctx);
  assert.equal(h.calls(), 4);
  assert.deepEqual(h.capsules[1], { supplementalInformation: '补充信息' });
  assert.equal(h.entries.at(-1).data.stage, 'ACCEPTED');
});

test('cancel or empty BLOCKED input stays blocked and does not repeat input', async () => {
  for (const input of [undefined, '']) {
    const h = harness([{ kind: 'investigation', route: 'needs_more_evidence', evidence: ['not enough'] }], [blocked], input);
    await h.command('登录后白屏', h.ctx);
    assert.equal(h.calls(), 1);
    assert.match(h.notifications.at(-1), /BLOCKED/);
  }
});
