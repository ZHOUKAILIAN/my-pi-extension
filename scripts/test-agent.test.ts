import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseEventReport, runAgentTests, snapshot } from './test-agent.mjs';
import { buildNodeTestCommand, launchNativeSuite } from './test-suite.mjs';

const agentModule = fileURLToPath(new URL('./test-agent.mjs', import.meta.url));

async function fixture(source: string, { git = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'test-agent-fixture-'));
  await mkdir(join(root, 'packages', 'fixture', 'test'), { recursive: true });
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node scripts/test-suite.mjs' } }));
  await writeFile(join(root, 'scripts', 'fixture.test.ts'), source);
  await writeFile(join(root, 'tracked.txt'), 'baseline');
  if (git) {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function collector() {
  let text = '';
  return { output: { write(chunk: string) { text += chunk; } }, text: () => text };
}

async function waitForFile(path: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await readFile(path, 'utf8'); } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
  throw new Error(`fixture readiness file not created: ${path}`);
}

test('agent summary handles nested tests, skip/todo, and logs full long output privately', async () => {
  const f = await fixture(`
    import test, { describe } from 'node:test';
    import assert from 'node:assert/strict';
    describe('nested suite', () => {
      test('pass', () => { console.log('LONG_SUCCESS_MARKER' + 'S'.repeat(20000)); console.log('SECOND_SUCCESS_MARKER'); console.error('LONG_TEST_STDERR_MARKER'); console.error('SECOND_STDERR_MARKER'); assert.equal(1, 1); });
      test('skip', { skip: 'fixture' }, () => {});
      test('todo', { todo: true }, () => {});
    });
  `);
  try {
    const output = collector();
    const result = await runAgentTests({ root: f.root, output: output.output });
    assert.equal(result.ok, true);
    assert.deepEqual([result.report.tests, result.report.passed, result.report.failed, result.report.skipped, result.report.todo, result.report.suites], [3, 1, 0, 1, 1, 1]);
    assert.doesNotMatch(output.text(), /LONG_SUCCESS_MARKER/);
    assert.match(await readFile(join(result.logsDir, 'test-output.events.jsonl'), 'utf8'), /LONG_SUCCESS_MARKER/);
    assert.match(await readFile(join(result.logsDir, 'test-stdout.log'), 'utf8'), /LONG_SUCCESS_MARKER[\s\S]*SECOND_SUCCESS_MARKER/);
    assert.match(await readFile(join(result.logsDir, 'test-stderr.log'), 'utf8'), /LONG_TEST_STDERR_MARKER[\s\S]*SECOND_STDERR_MARKER/);
    assert.equal((await stat(result.logsDir)).mode & 0o777, 0o700);
    for (const filename of ['test-output.events.jsonl', 'test-stdout.log', 'test-stderr.log', 'runner-stdout.log', 'runner-stderr.log', 'command.json']) {
      assert.equal((await stat(join(result.logsDir, filename))).mode & 0o777, 0o600);
    }
  } finally { await f.cleanup(); }
});

test('reporter safely serializes BigInt and cyclic assertion actual/expected values', async () => {
  const f = await fixture(`
    import test from 'node:test';
    import assert from 'node:assert/strict';
    test('bigint assertion', () => assert.equal(1n, 2n));
    test('circular assertion', () => { const actual = {}; actual.self = actual; assert.deepEqual(actual, { expected: true }); });
    test('wide assertion', () => assert.deepEqual(Object.fromEntries(Array.from({ length: 105 }, (_, index) => ['property' + index, index])), {}));
  `);
  try {
    const output = collector();
    const result = await runAgentTests({ root: f.root, output: output.output });
    assert.equal(result.ok, false);
    assert.equal(result.report.failed, 3);
    assert.match(output.text(), /bigint assertion/);
    const events = await readFile(join(result.logsDir, 'test-output.events.jsonl'), 'utf8');
    assert.match(events, /"\$type":"bigint"/);
    assert.match(events, /circular or repeated reference/);
    assert.match(events, /\$truncatedProperties/);
    assert.doesNotMatch(events, /Could not serialize a Node test event/);
  } finally { await f.cleanup(); }
});

test('agent summary retains assertion detail within budget and the full event report', async () => {
  const f = await fixture(`import test from 'node:test'; import assert from 'node:assert/strict'; test('known assertion', () => { console.error('LONG_TEST_STDERR_MARKER'); assert.equal('actual', 'expected', 'LONG_FAILURE_MARKER' + 'F'.repeat(20000)); });`);
  try {
    const output = collector();
    const result = await runAgentTests({ root: f.root, output: output.output });
    assert.equal(result.ok, false);
    assert.notEqual(result.exitCode, 0);
    assert.match(output.text(), /FAIL known assertion/);
    assert.match(output.text(), /actual|expected|AssertionError/);
    assert.match(output.text(), /failure detail clipped/);
    assert.ok(output.text().length < 8300);
    assert.match(await readFile(join(result.logsDir, 'test-output.events.jsonl'), 'utf8'), /LONG_FAILURE_MARKER/);
    assert.match(await readFile(join(result.logsDir, 'test-stderr.log'), 'utf8'), /LONG_TEST_STDERR_MARKER/);
  } finally { await f.cleanup(); }
});

test('agent summary rejects unknown, malformed, summary-only, missing-event, duplicate, and zero-test reports', async () => {
  for (const text of ['', 'not-json\n', JSON.stringify({ type: 'test:pass', data: {} })]) {
    assert.throws(() => parseEventReport(text));
  }
  const file = join(tmpdir(), 'expected-node-event.test.ts');
  const counts = { tests: 1, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0, suites: 0 };
  const event = (type: string, data: unknown) => JSON.stringify({ type, data });
  const fileSummary = event('test:summary', { success: true, counts, duration_ms: 1, file });
  const globalSummary = event('test:summary', { success: true, counts, duration_ms: 1 });
  const identity = { name: 'one test', file, nesting: 0, line: 1, column: 1, testNumber: 1 };
  assert.throws(() => parseEventReport(`${fileSummary}\n${globalSummary}`, [file]), /terminal test outcomes|global summary counts|file-wrapper/);
  assert.throws(() => parseEventReport(`${fileSummary}\n${globalSummary}\n${event('test:complete', { ...identity, details: { type: 'test', passed: true } })}`, [file]), /terminal test outcome/);
  assert.throws(() => parseEventReport(`${fileSummary}\n${globalSummary}\n${event('test:complete', { ...identity, details: { type: 'test', passed: true } })}\n${event('test:pass', identity)}\n${event('test:pass', identity)}`, [file]), /duplicated.*terminal test outcomes/);
  assert.throws(() => parseEventReport(globalSummary, [file]), /file-wrapper|per-file summary/);
  const f = await fixture(`import test from 'node:test';`);
  try {
    const output = collector();
    const result = await runAgentTests({ root: f.root, output: output.output });
    assert.equal(result.ok, false);
    assert.notEqual(result.exitCode, 0);
    assert.match(output.text(), /report=unrecognized/);
  } finally { await f.cleanup(); }
});

test('real native reports require one consistent file summary and file wrapper per nonempty file', async () => {
  const f = await fixture(`import test from 'node:test'; test('ordinary success', () => {});`);
  const namedFile = join(f.root, 'scripts', 'filename.test.ts');
  const emptyFile = join(f.root, 'scripts', 'empty.test.ts');
  await writeFile(namedFile, `import test from 'node:test'; test(import.meta.filename, () => {});`);
  await writeFile(emptyFile, '// legal empty file when mixed with real tests\n');
  try {
    const output = collector();
    const result = await runAgentTests({ root: f.root, output: output.output });
    assert.ok(result.report);
    assert.equal(result.ok, true);
    assert.deepEqual([result.report.tests, result.report.passed, result.report.failed], [2, 2, 0]);
    const text = await readFile(join(result.logsDir, 'test-output.events.jsonl'), 'utf8');
    const events = text.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const primarySummary = events.find((event) => event.type === 'test:summary' && event.data.file?.endsWith('/scripts/fixture.test.ts'));
    assert.ok(primarySummary, 'fixture must have a native per-file summary');
    const wrapper = (event) => event.type === 'test:complete' && event.data.file === primarySummary.data.file
      && event.data.name === 'scripts/fixture.test.ts' && event.data.nesting === 0 && event.data.line === 1 && event.data.column === 1;
    assert.equal(events.filter((event) => event.type === 'test:summary' && event.data.file === primarySummary.data.file).length, 1);
    assert.equal(events.filter(wrapper).length, 1);
    assert.ok(events.some((event) => event.type === 'test:complete' && event.data.name === event.data.file && event.data.name.endsWith('/scripts/filename.test.ts') && event.data.line === 1 && event.data.column > 1), 'filename-named user test remains an ordinary test');
    assert.ok(parseEventReport(text, result.command.files, f.root).success, 'real report must parse before damage mutations');
    const serialize = (variant: unknown[]) => `${variant.map((event) => JSON.stringify(event)).join('\n')}\n`;
    const wrapperIndex = events.findIndex(wrapper);
    assert.throws(() => parseEventReport(serialize(events.filter((_, index) => index !== wrapperIndex)), result.command.files, f.root), /file-wrapper/);
    const duplicatedWrapper = [...events];
    duplicatedWrapper.splice(wrapperIndex + 1, 0, events[wrapperIndex]);
    assert.throws(() => parseEventReport(serialize(duplicatedWrapper), result.command.files, f.root), /file-wrapper/);
    const inconsistentSuccess = structuredClone(events);
    const summaryForSuccess = inconsistentSuccess.find((event) => event.type === 'test:summary' && event.data.file === primarySummary.data.file);
    summaryForSuccess.data.success = false;
    summaryForSuccess.data.counts.failed = 1;
    assert.throws(() => parseEventReport(serialize(inconsistentSuccess), result.command.files, f.root), /file-wrapper|per-file.*(failed|success)/i);
    const inconsistentCounts = structuredClone(events);
    const summaryForCounts = inconsistentCounts.find((event) => event.type === 'test:summary' && event.data.file === primarySummary.data.file);
    summaryForCounts.data.counts.passed++;
    assert.throws(() => parseEventReport(serialize(inconsistentCounts), result.command.files, f.root), /per-file.*passed count/i);
  } finally { await f.cleanup(); }
});

test('native timeout cancellation and before-hook failure retain global counts and root cause', async () => {
  const f = await fixture(`
    import { before, describe, test } from 'node:test';
    test('timeout cancellation', { timeout: 80 }, async () => { await new Promise(() => {}); });
    describe('hook failure suite', () => {
      before(() => { throw Object.assign(new Error('BEFORE_HOOK_ROOT_CAUSE'), { code: 'HOOK_ROOT_CODE' }); });
      test('cancelled child', () => {});
    });
  `);
  try {
    const output = collector();
    const result = await runAgentTests({ root: f.root, output: output.output });
    assert.equal(result.ok, false);
    assert.equal(result.report.failed, 0);
    assert.equal(result.report.cancelled, 2);
    assert.equal(result.report.suites, 1);
    assert.equal(result.report.tests, 2);
    assert.match(output.text(), /cancelled=2/);
    assert.match(output.text(), /failed running before hook/);
    assert.match(output.text(), /BEFORE_HOOK_ROOT_CAUSE/);
    assert.match(output.text(), /HOOK_ROOT_CODE/);
  } finally { await f.cleanup(); }
});

test('native skip, todo, cancellation, and failure counts follow Node priority', async () => {
  const cases = [
    {
      name: 'todo timeout',
      source: `import test from 'node:test'; test('expected timeout', { todo: true, timeout: 20 }, async () => new Promise(() => {}));`,
      expected: { tests: 1, todo: 1, skipped: 0, cancelled: 0, failed: 0, success: true },
    },
    {
      name: 'todo hook failure',
      source: `import { before, describe, it } from 'node:test'; describe('todo suite', { todo: true }, () => { before(() => { throw new Error('TODO_HOOK_ROOT_CAUSE'); }); it('child', () => {}); });`,
      expected: { tests: 1, todo: 1, skipped: 0, cancelled: 0, failed: 0, success: false },
    },
    {
      name: 'ordinary todo failure',
      source: `import test from 'node:test'; test('expected failure', { todo: true }, () => { throw new Error('TODO_FAILURE'); });`,
      expected: { tests: 1, todo: 1, skipped: 0, cancelled: 0, failed: 0, success: true },
    },
    {
      name: 'skip plus todo',
      source: `import test from 'node:test'; test('skip todo', { skip: true, todo: true }, () => {});`,
      expected: { tests: 1, todo: 0, skipped: 1, cancelled: 0, failed: 0, success: true },
    },
  ];
  for (const fixtureCase of cases) {
    const f = await fixture(fixtureCase.source);
    try {
      const output = collector();
      const result = await runAgentTests({ root: f.root, output: output.output });
      assert.ok(result.report, `${fixtureCase.name}: native report should parse`);
      assert.deepEqual({ tests: result.report.tests, todo: result.report.todo, skipped: result.report.skipped, cancelled: result.report.cancelled, failed: result.report.failed, success: result.report.success }, fixtureCase.expected);
      assert.equal(result.ok, fixtureCase.expected.success);
      if (fixtureCase.name === 'todo hook failure') {
        assert.match(output.text(), /failed running before hook/);
        assert.match(output.text(), /TODO_HOOK_ROOT_CAUSE/);
      }
    } finally { await f.cleanup(); }
  }
});

test('runner, test stdout/stderr, and event writer failures terminate live descendants', async () => {
  const sinks = [
    { name: 'test-stdout', delayMs: 250 },
    { name: 'test-stderr', delayMs: 250 },
    { name: 'events', delayMs: 250 },
    { name: 'runner-stdout', delayMs: 2500 },
    { name: 'runner-stderr', delayMs: 2500 },
  ];
  for (const { name, delayMs } of sinks) {
    const readyPath = join(tmpdir(), `test-agent-log-failure-${process.pid}-${name}`);
    const f = await fixture(`
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      import test from 'node:test';
      test('live descendant during log fault', async () => {
        const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"]);
        writeFileSync(${JSON.stringify(readyPath)}, String(child.pid));
        console.log('TRIGGER_STDOUT');
        console.error('TRIGGER_STDERR');
        await new Promise(() => {});
      });
    `);
    const logDirectory = join(tmpdir(), `test-agent-log-directory-${process.pid}-${name}`);
    try {
      await mkdir(logDirectory, { recursive: true });
      const started = Date.now();
      const running = runAgentTests({ root: f.root, timeoutMs: 15_000, output: collector().output, logDirectory, logFailure: { sink: name, delayMs } });
      const childPid = Number(await waitForFile(readyPath));
      const result = await running;
      assert.equal(result.ok, false, `${name} fault must fail the run`);
      assert.notEqual(result.exitCode, 124, `${name} fault must be detected before timeout`);
      assert.ok(Date.now() - started < 10_000, `${name} fault must stop the runner promptly`);
      assert.match(result.summary, /log write failure|reporter failure|reporter\/stderr|unrecognized/i);
      assert.match(result.summary, /test-output\.events\.jsonl/);
      assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
    } finally {
      await rm(readyPath, { force: true });
      await f.cleanup();
      await rm(logDirectory, { recursive: true, force: true });
    }
  }
});

test('syntax and import failures expose useful runner diagnostics', async () => {
  const f = await fixture(`import './missing-fixture-import.mjs';`);
  try {
    const output = collector();
    const result = await runAgentTests({ root: f.root, output: output.output });
    assert.equal(result.ok, false);
    assert.notEqual(result.exitCode, 0);
    assert.match(output.text(), /missing-fixture-import|ERR_MODULE_NOT_FOUND|Cannot find module/);
    assert.match(await readFile(join(result.logsDir, 'test-output.events.jsonl'), 'utf8'), /missing-fixture-import|ERR_MODULE_NOT_FOUND/);
  } finally { await f.cleanup(); }
});

test('shared npm test owner runs explicit extra files and rejects unsupported arguments/hooks', async () => {
  const f = await fixture(`import test from 'node:test'; test('base suite', () => {});`);
  const extra = join(f.root, 'explicit-extra.mjs');
  await writeFile(extra, `import test from 'node:test'; import assert from 'node:assert/strict'; test('extra failure', () => assert.fail('extra file ran'));`);
  try {
    const run = await launchNativeSuite({ root: f.root, additionalFiles: [extra], captureOutput: true });
    assert.equal(run.code, 1);
    assert.match(run.stdout, /extra failure/);
    assert.match(run.stdout, /ℹ tests 2/);
    const agent = await runAgentTests({ root: f.root, additionalFiles: [extra], output: collector().output });
    assert.equal(agent.exitCode, 1);
    assert.equal(agent.report.failed, 1);
    await assert.rejects(buildNodeTestCommand({ root: f.root, additionalFiles: ['--test-reporter=tap'] }), /only additional test file paths/);
    const manifest = JSON.parse(await readFile(join(f.root, 'package.json'), 'utf8'));
    manifest.scripts.pretest = 'node does-not-run.js';
    manifest.scripts.posttest = 'node does-not-run.js';
    await writeFile(join(f.root, 'package.json'), JSON.stringify(manifest));
    await assert.rejects(buildNodeTestCommand({ root: f.root, rejectTestHooks: true }), /pretest\/posttest hooks/);
    manifest.scripts.test = 'node --test';
    await writeFile(join(f.root, 'package.json'), JSON.stringify(manifest));
    await assert.rejects(buildNodeTestCommand({ root: f.root }), /Unsupported npm test command/);
  } finally { await f.cleanup(); }
});

test('agent summary preserves startup failure as a nonzero result', async () => {
  const f = await fixture(`import test from 'node:test'; test('never reached', () => {});`);
  try {
    const output = collector();
    const result = await runAgentTests({ root: f.root, nodePath: join(f.root, 'missing-node'), output: output.output });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 127);
    assert.match(output.text(), /Runner startup error:.*ENOENT/);
    assert.match(await readFile(join(result.logsDir, 'runner-stderr.log'), 'utf8'), /ENOENT/);
  } finally { await f.cleanup(); }
});

test('timeout waits for SIGKILL escalation of a descendant that ignores SIGTERM', async () => {
  const readyPath = join(tmpdir(), `test-agent-ready-${process.pid}`);
  const f = await fixture(`
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    import test from 'node:test';
    test('stuck worker', async () => {
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"]);
      writeFileSync(${JSON.stringify(readyPath)}, String(child.pid));
      await new Promise(() => {});
    });
  `);
  try {
    const resultPromise = runAgentTests({ root: f.root, timeoutMs: 10_000, output: collector().output });
    const pid = Number(await waitForFile(readyPath));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const result = await resultPromise;
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 124);
    assert.match(result.summary, /exit=124/);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    await rm(readyPath, { force: true });
    await f.cleanup();
  }
});

test('external SIGTERM cancels the wrapper and waits for its test process cleanup', async () => {
  const readyPath = join(tmpdir(), `test-agent-external-${process.pid}`);
  const f = await fixture(`
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    import test from 'node:test';
    test('stuck worker', async () => {
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"]);
      writeFileSync(${JSON.stringify(readyPath)}, String(child.pid));
      await new Promise(() => {});
    });
  `);
  const wrapperCode = `import {runAgentTests} from ${JSON.stringify(agentModule)}; const result=await runAgentTests({root:${JSON.stringify(f.root)}}); process.exitCode=result.exitCode;`;
  const wrapper = spawn(process.execPath, ['--input-type=module', '-e', wrapperCode], { stdio: 'ignore' });
  try {
    const childPid = Number(await waitForFile(readyPath));
    wrapper.kill('SIGTERM');
    const code = await new Promise<number | null>((resolve) => wrapper.once('close', (status) => resolve(status)));
    assert.equal(code, 143);
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
  } finally {
    wrapper.kill('SIGKILL');
    await rm(readyPath, { force: true });
    await f.cleanup();
  }
});

test('non-Git fixture snapshots remain explicitly unavailable and cannot claim PASS', async () => {
  const f = await fixture(`import test from 'node:test'; test('fixture passes', () => {});`, { git: false });
  try {
    const snapshotValue = await snapshot(f.root);
    assert.equal(snapshotValue.available, false);
    assert.match(snapshotValue.value, /unavailable/);
    const output = collector();
    const result = await runAgentTests({ root: f.root, output: output.output });
    assert.equal(result.ok, false);
    assert.match(output.text(), /UNAVAILABLE/);
  } finally { await f.cleanup(); }
});

test('Git snapshot hashes NUL-safe Unicode untracked contents and detects test-time mutation', async () => {
  const f = await fixture(`
    import { writeFileSync } from 'node:fs';
    import test from 'node:test';
    test('mutate tracked source during run', async () => {
      writeFileSync('tracked.txt', 'changed during test');
    });
  `, { git: true });
  try {
    const untracked = join(f.root, '中文 文件.txt');
    await writeFile(untracked, 'first');
    const first = await snapshot(f.root);
    await writeFile(untracked, 'second');
    const second = await snapshot(f.root);
    assert.notEqual(first.value, second.value);
    const output = collector();
    const result = await runAgentTests({ root: f.root, output: output.output });
    assert.equal(result.ok, false);
    assert.notEqual(result.before.value, result.ended.value);
    assert.match(output.text(), /CHANGED\/UNAVAILABLE/);
  } finally { await f.cleanup(); }
});
