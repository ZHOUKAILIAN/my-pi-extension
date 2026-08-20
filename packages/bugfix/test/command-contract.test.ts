import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension from '../src/extension.ts';

function commandHarness(options: { answers?: any[]; cwd?: string; model?: any; registry?: any; hasUI?: boolean; input?: string } = {}) {
  const entries: any[] = [];
  const notifications: string[] = [];
  let command: any;
  let calls = 0;
  let inputCalls = 0;
  const answers = options.answers ?? [];
  const pi: any = {
    bugFixWorker: { execute: async () => answers[calls++] },
    appendEntry: (customType: string, data: any) => entries.push({ customType, data }),
    registerCommand: (_name: string, value: any) => { command = value.handler; },
  };
  const ctx: any = {
    cwd: options.cwd ?? mkdtempSync(join(tmpdir(), 'bugfix-test-cwd-')),
    model: options.model,
    modelRegistry: options.registry,
    thinkingLevel: 'high',
    hasUI: options.hasUI ?? true,
    isProjectTrusted: () => true,
    sessionManager: { getEntries: () => entries },
    ui: {
      input: async () => { inputCalls += 1; return options.input; },
      notify: (message: string) => notifications.push(message),
    },
  };
  extension(pi);
  return { command, ctx, entries, notifications, calls: () => calls, inputCalls: () => inputCalls };
}

const acceptedAnswers = () => [
  { kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'] },
  { kind: 'implementation', artifact: { summary: 'patch', filesChanged: ['a.ts'], candidateRevision: 'rev-1' } },
  { kind: 'verification', accepted: true, evidence: ['tests'], candidateRevision: 'rev-1' },
];

test('each identical problem starts a distinct run', async () => {
  const h = commandHarness({ answers: [...acceptedAnswers(), ...acceptedAnswers()] });
  await h.command('登录后白屏', h.ctx);
  await h.command('登录后白屏', h.ctx);
  const initials = h.entries.filter((entry) => entry.customType === 'workflow-run' && entry.data.id.endsWith('-initial'));
  assert.equal(initials.length, 2);
  assert.notEqual(initials[0].data.runId, initials[1].data.runId);
});

test('a policy failure writes no command, checkpoint, audit, or worker output', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bugfix-command-'));
  mkdirSync(join(cwd, '.pi'));
  writeFileSync(join(cwd, '.pi', 'workflow-models.json'), '{');
  const h = commandHarness({ cwd, answers: acceptedAnswers() });
  await h.command('登录后白屏', h.ctx);
  assert.equal(h.calls(), 0);
  assert.deepEqual(h.entries, []);
});

test('a missing configured model writes no command, checkpoint, audit, or worker output', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bugfix-command-'));
  mkdirSync(join(cwd, '.pi'));
  writeFileSync(join(cwd, '.pi', 'workflow-models.json'), JSON.stringify({ version: 1, default: 'missing/model' }));
  const h = commandHarness({ cwd, answers: acceptedAnswers(), registry: { find: () => undefined } });
  await h.command('登录后白屏', h.ctx);
  assert.equal(h.calls(), 0);
  assert.deepEqual(h.entries, []);
});

test('a BLOCKED run without UI does not ask for input or retry', async () => {
  const h = commandHarness({
    hasUI: false,
    answers: [{ kind: 'investigation', route: 'needs_more_evidence', rootCause: 'evidence incomplete', evidence: ['missing'] }],
  });
  await h.command('登录后白屏', h.ctx);
  assert.equal(h.calls(), 1);
  assert.equal(h.inputCalls(), 0);
  assert.equal(h.entries.filter((entry) => entry.customType === 'workflow-run').at(-1).data.stage, 'BLOCKED');
});

test('an invalid implementation artifact is retried and only a valid retry advances the workflow', async () => {
  const h = commandHarness({
    answers: [
      { kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'] },
      { kind: 'implementation', artifact: { summary: 'missing revision', filesChanged: ['a.ts'] } },
      { kind: 'implementation', artifact: { summary: 'patch', filesChanged: ['a.ts'], candidateRevision: 'rev-1' } },
      { kind: 'verification', accepted: true, evidence: ['tests'], candidateRevision: 'rev-1' },
    ],
  });
  await h.command('登录后白屏', h.ctx);
  assert.equal(h.calls(), 4);
  assert.equal(h.entries.filter((entry) => entry.customType === 'workflow-run').at(-1).data.stage, 'ACCEPTED');
});

test('a repeatedly invalid implementation result pauses with an IMPLEMENTING checkpoint', async () => {
  const h = commandHarness({
    answers: [
      { kind: 'investigation', route: 'local_fix', rootCause: 'cause', evidence: ['trace'] },
      { kind: 'implementation', artifact: { summary: 'missing revision', filesChanged: ['a.ts'] } },
      { kind: 'implementation', artifact: { summary: 'still missing revision', filesChanged: ['a.ts'] } },
    ],
  });
  await h.command('登录后白屏', h.ctx);
  assert.equal(h.calls(), 3);
  assert.equal(h.entries.filter((entry) => entry.customType === 'workflow-run').at(-1).data.stage, 'IMPLEMENTING');
  assert.equal(h.entries.filter((entry) => entry.customType === 'workflow-node-failure').at(-1).data.code, 'MISSING_CANDIDATE_REVISION');
  assert.match(h.notifications.at(-1), /IMPLEMENTING paused/);
});
