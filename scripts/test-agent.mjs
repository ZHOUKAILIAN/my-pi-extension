import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { constants as osConstants, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createWriteStream, realpathSync } from 'node:fs';
import { finished } from 'node:stream/promises';
import { buildNodeTestCommand, repoRoot } from './test-suite.mjs';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_BUDGET = 8000;
const reporterPath = fileURLToPath(new URL('./test-agent-reporter.mjs', import.meta.url));
const signalExitCode = (signal) => 128 + (osConstants.signals[signal] ?? 0);

export function parseEventReport(text, expectedFiles = [], root = process.cwd()) {
  const allowedEvents = new Set(['reporter:error', 'test:coverage', 'test:complete', 'test:dequeue', 'test:diagnostic', 'test:enqueue', 'test:fail', 'test:interrupted', 'test:pass', 'test:plan', 'test:start', 'test:stderr', 'test:stdout', 'test:summary']);
  let globalSummary;
  const fileSummaries = new Map();
  const completions = new Map();
  const outcomes = new Map();
  const starts = new Map();
  const failures = [];
  const diagnostics = [];
  const reporterErrors = [];
  let recognizedEvents = 0;
  const canonicalPath = (file) => { try { return realpathSync(file); } catch { return resolve(file); } };
  const filePaths = new Set(expectedFiles.map(canonicalPath));
  const eventKey = (data) => {
    if (typeof data.name !== 'string' || typeof data.file !== 'string' || !Number.isSafeInteger(data.nesting) || !Number.isSafeInteger(data.line) || !Number.isSafeInteger(data.column)) {
      throw new Error('Node test event is missing its identity fields');
    }
    return JSON.stringify([canonicalPath(data.file), data.name, data.nesting, data.line, data.column]);
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); } catch { throw new Error('Structured Node report contains invalid JSON'); }
    if (!event || typeof event.type !== 'string' || !event.data || typeof event.data !== 'object') {
      throw new Error('Structured Node report contains an unknown event shape');
    }
    if (!allowedEvents.has(event.type)) throw new Error(`Unsupported Node reporter event: ${event.type}`);
    recognizedEvents++;
    if (event.type === 'test:summary') {
      if (event.data.file === undefined) {
        if (globalSummary) throw new Error('Structured Node report contains duplicate global summaries');
        globalSummary = event.data;
      } else {
        const path = canonicalPath(event.data.file);
        if (!filePaths.has(path) || fileSummaries.has(path)) throw new Error('Structured Node report has an unexpected or duplicate file summary');
        fileSummaries.set(path, event.data);
      }
    }
    if (event.type === 'test:complete') {
      const key = eventKey(event.data);
      if (!['test', 'suite'].includes(event.data.details?.type) || typeof event.data.details?.passed !== 'boolean') throw new Error('Structured Node report contains an incomplete test completion');
      if (!filePaths.has(canonicalPath(event.data.file))) throw new Error('Structured Node report contains a completion for an unexpected file');
      const group = completions.get(key) ?? [];
      group.push(event.data);
      completions.set(key, group);
    }
    if (event.type === 'test:start') {
      const key = eventKey(event.data);
      starts.set(key, (starts.get(key) ?? 0) + 1);
    }
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      const key = eventKey(event.data);
      const group = outcomes.get(key) ?? { passed: 0, failed: 0 };
      group[event.type === 'test:pass' ? 'passed' : 'failed']++;
      outcomes.set(key, group);
      if (event.type === 'test:fail') failures.push(event.data);
    }
    if (event.type === 'test:stderr' || (event.type === 'test:diagnostic' && event.data.level === 'error')) diagnostics.push(event.data);
    if (event.type === 'reporter:error') reporterErrors.push(event.data);
  }
  if (reporterErrors.length) throw new Error(`Node reporter failure: ${reporterErrors.map((item) => item.message).join('; ')}`);
  if (!recognizedEvents || !globalSummary || !globalSummary.counts) {
    throw new Error('Structured Node report is incomplete or unrecognized');
  }
  const { counts } = globalSummary;
  if (typeof globalSummary.success !== 'boolean' || !Number.isFinite(globalSummary.duration_ms)) throw new Error('Structured Node report summary is incomplete');
  for (const key of ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo', 'suites']) {
    if (!Number.isSafeInteger(counts[key]) || counts[key] < 0) throw new Error(`Structured Node report has invalid ${key} count`);
  }
  const canonicalRoot = canonicalPath(root);
  const isFileWrapper = (item) => {
    if (item.details.type !== 'test' || item.nesting !== 0 || item.line !== 1 || item.column !== 1) return false;
    const file = canonicalPath(item.file);
    const relativeName = relative(canonicalRoot, file);
    return item.name === relativeName || (isAbsolute(item.name) && canonicalPath(item.name) === file);
  };
  for (const key of outcomes.keys()) {
    if (!completions.has(key)) throw new Error('Test pass/fail event has no matching completion');
  }
  for (const [key, records] of completions) {
    if (records.some(isFileWrapper)) continue;
    const outcome = outcomes.get(key) ?? { passed: 0, failed: 0 };
    if (outcome.passed !== records.filter((item) => item.details.passed).length
        || outcome.failed !== records.filter((item) => !item.details.passed).length) {
      throw new Error('Structured Node report is missing, duplicated, or contradicts terminal test outcomes');
    }
  }
  const wrapperRecords = new Set();
  const emptyFiles = new Set();
  const fileCountKeys = ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo', 'suites'];
  const validateSummaryCounts = (summary, actual, label) => {
    if (!summary || typeof summary.success !== 'boolean' || !Number.isFinite(summary.duration_ms) || !summary.counts) {
      throw new Error(`${label} summary is incomplete`);
    }
    for (const key of fileCountKeys) {
      if (!Number.isSafeInteger(summary.counts[key]) || summary.counts[key] < 0 || summary.counts[key] !== actual[key]) {
        throw new Error(`${label} ${key} count does not match complete terminal events`);
      }
    }
    const success = actual.failed === 0 && actual.cancelled === 0 && actual.suitesPassed;
    if (summary.success !== success) throw new Error(`${label} success flag does not match terminal outcomes`);
  };
  const summarizeRecords = (testRecords, suiteRecords) => {
    const failed = testRecords.filter((item) => !item.details.passed && !item.skip && !item.todo && !['testTimeoutFailure', 'cancelledByParent'].includes(item.details.error?.failureType));
    const cancelled = testRecords.filter((item) => !item.skip && !item.todo && ['testTimeoutFailure', 'cancelledByParent'].includes(item.details.error?.failureType));
    const skipped = testRecords.filter((item) => Boolean(item.skip));
    const todo = testRecords.filter((item) => !item.skip && Boolean(item.todo));
    const passed = testRecords.filter((item) => item.details.passed && !item.skip && !item.todo);
    return { tests: testRecords.length, passed: passed.length, failed: failed.length, cancelled: cancelled.length, skipped: skipped.length, todo: todo.length, suites: suiteRecords.length, suitesPassed: suiteRecords.every((item) => item.details.passed) };
  };
  for (const file of filePaths) {
    const candidates = [...completions.entries()].flatMap(([key, records]) => records.filter(isFileWrapper).map((record) => ({ key, records, record })));
    const fileCandidates = candidates.filter(({ record }) => canonicalPath(record.file) === file);
    const candidateKeys = new Set(fileCandidates.map(({ key }) => key));
    if (candidateKeys.size !== 1) throw new Error('Structured Node report is missing or duplicates a file-wrapper completion');
    const [{ key, records }] = fileCandidates;
    const fileSummary = fileSummaries.get(file);
    if (!fileSummary && fileCandidates.length !== 1) throw new Error('Structured Node report has an invalid empty-file wrapper');
    if (fileSummary) {
      if (!fileSummary.counts) throw new Error('Per-file Node summary is incomplete');
      for (const countKey of fileCountKeys) {
        if (!Number.isSafeInteger(fileSummary.counts[countKey]) || fileSummary.counts[countKey] < 0) throw new Error(`Per-file Node summary has invalid ${countKey} count`);
      }
      const isEmptySummary = fileSummary.counts.tests === 0 && fileSummary.counts.suites === 0;
      if (isEmptySummary) {
        const outcome = outcomes.get(key) ?? { passed: 0, failed: 0 };
        if (records.length !== 1 || starts.get(key) !== 1 || outcome.passed !== 1 || outcome.failed !== 0 || !records[0].details.passed) {
          throw new Error('Per-file empty summary does not match its file-wrapper completion');
        }
        wrapperRecords.add(records[0]);
        emptyFiles.add(file);
        validateSummaryCounts(fileSummary, { tests: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0, suites: 0, suitesPassed: true }, 'Per-file Node');
        continue;
      }
      const started = starts.get(key) ?? 0;
      if (records.length - started !== 1) throw new Error('Structured Node report is missing or duplicates a file-wrapper completion');
      const outcome = outcomes.get(key) ?? { passed: 0, failed: 0 };
      const wrapperIndex = records.findIndex((record, index) => {
        if (record.details.passed !== fileSummary.success) return false;
        const remaining = records.filter((_, candidateIndex) => candidateIndex !== index);
        return remaining.length === started
          && outcome.passed === remaining.filter((item) => item.details.passed).length
          && outcome.failed === remaining.filter((item) => !item.details.passed).length;
      });
      if (wrapperIndex < 0) throw new Error('File-wrapper completion contradicts its per-file summary or terminal outcomes');
      const wrapper = records[wrapperIndex];
      wrapperRecords.add(wrapper);
      const localRecords = [...completions.values()].flat().filter((item) => canonicalPath(item.file) === file && item !== wrapper);
      const localTests = localRecords.filter((item) => item.details.type === 'test');
      const localSuites = localRecords.filter((item) => item.details.type === 'suite');
      validateSummaryCounts(fileSummary, summarizeRecords(localTests, localSuites), 'Per-file Node');
    } else {
      const outcome = outcomes.get(key) ?? { passed: 0, failed: 0 };
      const fileRecords = [...completions.values()].flat().filter((item) => canonicalPath(item.file) === file);
      if (records.length !== 1 || starts.get(key) !== 1 || outcome.passed !== 1 || outcome.failed !== 0 || !records[0].details.passed || fileRecords.length !== 1) {
        throw new Error('Structured Node report is missing a per-file summary or valid empty-file wrapper');
      }
      wrapperRecords.add(records[0]);
      emptyFiles.add(file);
    }
  }
  if (fileSummaries.size !== filePaths.size - emptyFiles.size) throw new Error('Structured Node report is missing or has unexpected per-file summaries');
  const completionRecords = [...completions.entries()].flatMap(([key, records]) => {
    const normalRecords = records.filter((item) => !wrapperRecords.has(item));
    const outcome = outcomes.get(key) ?? { passed: 0, failed: 0 };
    if (normalRecords.length === 0) {
      const isEmpty = records.some((item) => emptyFiles.has(canonicalPath(item.file)));
      if (isEmpty ? outcome.passed !== 1 || outcome.failed !== 0 : outcome.passed + outcome.failed !== 0) {
        throw new Error('File-wrapper completion has missing or contradictory terminal outcomes');
      }
      return records.map((item) => ({ ...item, _ignoredWrapper: true }));
    }
    if (outcome.passed !== normalRecords.filter((item) => item.details.passed).length
        || outcome.failed !== normalRecords.filter((item) => !item.details.passed).length) {
      throw new Error('Structured Node report is missing, duplicated, or contradicts terminal test outcomes');
    }
    return records.map((item) => ({ ...item, _ignoredWrapper: wrapperRecords.has(item) }));
  });
  const tests = completionRecords.filter((item) => item.details.type === 'test' && !item._ignoredWrapper);
  const suites = completionRecords.filter((item) => item.details.type === 'suite');
  const failedTests = tests.filter((item) => !item.details.passed && !item.skip && !item.todo && !['testTimeoutFailure', 'cancelledByParent'].includes(item.details.error?.failureType));
  const cancelledTests = tests.filter((item) => !item.skip && !item.todo && ['testTimeoutFailure', 'cancelledByParent'].includes(item.details.error?.failureType));
  const skippedTests = tests.filter((item) => Boolean(item.skip));
  const todoTests = tests.filter((item) => !item.skip && Boolean(item.todo));
  const passedTests = tests.filter((item) => item.details.passed && !item.skip && !item.todo);
  if (counts.tests !== tests.length + emptyFiles.size || counts.suites !== suites.length
      || counts.passed !== passedTests.length + emptyFiles.size
      || counts.failed !== failedTests.length || counts.cancelled !== cancelledTests.length
      || counts.skipped !== skippedTests.length || counts.todo !== todoTests.length) {
    throw new Error('Node global summary counts do not match complete terminal events');
  }
  const aggregateFileCounts = Object.fromEntries(fileCountKeys.map((key) => [key, 0]));
  for (const summary of fileSummaries.values()) for (const key of fileCountKeys) aggregateFileCounts[key] += summary.counts[key];
  aggregateFileCounts.tests += emptyFiles.size;
  aggregateFileCounts.passed += emptyFiles.size;
  if (fileCountKeys.some((key) => aggregateFileCounts[key] !== counts[key])) throw new Error('Node global counts do not match per-file summaries');
  if (globalSummary.success !== (counts.failed === 0 && counts.cancelled === 0 && suites.every((item) => item.details.passed))) {
    throw new Error('Node global summary success flag does not match terminal outcomes');
  }
  if (tests.length === 0) throw new Error('Node test runner reported zero actual tests');
  return { ...counts, tests: tests.length, passed: passedTests.length, durationMs: globalSummary.duration_ms, success: globalSummary.success, failures, diagnostics };
}

export async function snapshot(root, inputFiles = []) {
  const git = (args) => new Promise((done) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; done(value); } };
    let child;
    try { child = spawn('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { finish(undefined); return; }
    const chunks = [];
    child.stdout?.on('data', (chunk) => chunks.push(chunk));
    child.once('error', () => finish(undefined));
    child.once('close', (code) => finish(code === 0 ? Buffer.concat(chunks) : undefined));
  });
  const [head, status] = await Promise.all([
    git(['rev-parse', 'HEAD']),
    git(['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  ]);
  if (!head || !status) return { available: false, value: 'unavailable (not a Git worktree)' };
  const hash = createHash('sha256').update(status);
  for (const args of [['diff', 'HEAD', '--binary'], ['diff', '--cached', '--binary']]) {
    const diff = await git(args);
    if (!diff) return { available: false, value: 'unavailable (cannot read Git diff)' };
    hash.update(diff);
  }
  for (const record of status.toString('utf8').split('\0')) {
    if (record.startsWith('?? ')) {
      const filePath = record.slice(3);
      hash.update(filePath);
      try { hash.update(await readFile(join(root, filePath))); }
      catch (error) { return { available: false, value: `unavailable (cannot hash untracked path: ${error.message})` }; }
    }
  }
  for (const input of inputFiles) {
    const absoluteInput = resolve(root, input);
    const rel = relative(root, absoluteInput);
    if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) continue;
    hash.update(absoluteInput);
    try { hash.update(await readFile(absoluteInput)); }
    catch (error) { return { available: false, value: `unavailable (cannot hash external test input: ${error.message})` }; }
  }
  return { available: true, value: `${head.toString('utf8').trim()}+worktree:${hash.digest('hex').slice(0, 16)}` };
}

function signalProcessGroup(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {}
}

async function terminateTree(child) {
  signalProcessGroup(child, 'SIGTERM');
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500));
  signalProcessGroup(child, 'SIGKILL');
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
}

function parseDuration(value) {
  const match = value.match(/^(\d+)(ms|s|m|h)?$/);
  if (!match) throw new Error(`Invalid timeout duration: ${value}`);
  const duration = Number(match[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2] ?? 'ms'];
  if (!Number.isSafeInteger(duration) || duration < 1) throw new Error('Timeout must be a positive duration');
  return duration;
}

function usage() {
  return 'Usage: npm run test:agent -- [--timeout <duration>] [test-file ...] [--help]\nTimeout defaults to 10m; duration accepts ms, s, m, or h (for example 90s). Additional positional arguments must be test file paths.\n';
}

export async function runAgentTests({ root = repoRoot, timeoutMs = DEFAULT_TIMEOUT_MS, output = process.stdout, nodePath = process.execPath, env = {}, additionalFiles = [], logDirectory, logFailure } = {}) {
  const logsDir = logDirectory ? resolve(logDirectory) : await mkdtemp(join(tmpdir(), 'pi-test-agent-'));
  await mkdir(logsDir, { recursive: true, mode: 0o700 });
  await chmod(logsDir, 0o700);
  const reportPath = join(logsDir, 'test-output.events.jsonl');
  const stdoutPath = join(logsDir, 'test-stdout.log');
  const stderrPath = join(logsDir, 'test-stderr.log');
  const runnerStdoutPath = join(logsDir, 'runner-stdout.log');
  const runnerStderrPath = join(logsDir, 'runner-stderr.log');
  const metadataPath = join(logsDir, 'command.json');
  const reporterUrl = new URL(pathToFileURL(reporterPath));
  reporterUrl.searchParams.set('stdout', stdoutPath);
  reporterUrl.searchParams.set('stderr', stderrPath);
  if (logFailure?.sink) {
    reporterUrl.searchParams.set('failSink', logFailure.sink);
    reporterUrl.searchParams.set('failDelayMs', String(logFailure.delayMs ?? 0));
  }
  const command = await buildNodeTestCommand({ root, reporter: reporterUrl.href, reporterDestination: reportPath, additionalFiles, rejectTestHooks: true });
  const before = await snapshot(root, command.files);
  command.executable = nodePath;
  for (const file of [reportPath, stdoutPath, stderrPath, runnerStdoutPath, runnerStderrPath]) {
    await writeFile(file, '', { mode: 0o600 });
    await chmod(file, 0o600);
  }
  await writeFile(metadataPath, JSON.stringify({ executable: command.executable, args: command.args, cwd: root }, null, 2), { mode: 0o600 });
  const createRunnerLog = (path, sink) => {
    const stream = createWriteStream(path, { mode: 0o600 });
    if (logFailure?.sink === sink) {
      const timer = setTimeout(() => stream.destroy(new Error(`Injected ${sink} log write failure`)), logFailure.delayMs ?? 0);
      stream.once('close', () => clearTimeout(timer));
    }
    return stream;
  };
  const stdoutStream = createRunnerLog(runnerStdoutPath, 'runner-stdout');
  const stderrStream = createRunnerLog(runnerStderrPath, 'runner-stderr');
  const started = Date.now();
  let exitCode;
  let signal;
  let timedOut = false;
  let externalSignal;
  let child;
  let cleanupPromise;
  let spawnError;
  let streamError;
  const requestStop = (reason) => {
    if (cleanupPromise) return cleanupPromise;
    if (reason === 'timeout') timedOut = true;
    else externalSignal = reason;
    cleanupPromise = terminateTree(child);
    return cleanupPromise;
  };
  const onInterrupt = () => { void requestStop('SIGINT'); };
  const onTerminate = () => { void requestStop('SIGTERM'); };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  const timeout = setTimeout(() => { void requestStop('timeout'); }, timeoutMs);
  try {
    const childEnv = { ...process.env, ...env };
    delete childEnv.NODE_TEST_CONTEXT;
    child = spawn(command.executable, command.args, {
      cwd: root,
      env: childEnv,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(stdoutStream);
    child.stderr.pipe(stderrStream);
    const streamsDone = Promise.all([finished(stdoutStream), finished(stderrStream)]).catch(async (error) => {
      streamError = error;
      cleanupPromise ??= terminateTree(child);
      await cleanupPromise;
    });
    child.once('error', (error) => { spawnError = error; });
    const result = await new Promise((resolvePromise) => child.once('close', (code, childSignal) => resolvePromise({ code, childSignal })));
    await streamsDone;
    exitCode = result.code;
    signal = result.childSignal;
    if (!spawnError && (result.code !== 0 || result.childSignal) && !cleanupPromise) cleanupPromise = terminateTree(child);
  } catch (error) {
    spawnError ??= error;
    stdoutStream.end();
    stderrStream.end();
    await Promise.allSettled([finished(stdoutStream), finished(stderrStream)]);
    exitCode = 127;
  } finally {
    clearTimeout(timeout);
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  }
  if (cleanupPromise) await cleanupPromise;
  await Promise.allSettled([finished(stdoutStream), finished(stderrStream)]);
  if (spawnError) await writeFile(runnerStderrPath, `Unable to start Node test runner: ${spawnError.message}\n`, { mode: 0o600 });
  const ended = await snapshot(root, command.files);
  const snapshotStable = before.available && ended.available && before.value === ended.value;
  let report;
  let reportError;
  try { report = parseEventReport(await readFile(reportPath, 'utf8'), command.files, root); }
  catch (error) { reportError = error.message; }
  const durationMs = Date.now() - started;
  const reportedCode = spawnError ? 127 : streamError ? 1 : timedOut ? 124 : externalSignal ? signalExitCode(externalSignal) : signal ? signalExitCode(signal) : exitCode ?? 1;
  const success = reportedCode === 0 && report?.success === true && report.failed === 0 && report.cancelled === 0 && snapshotStable;
  const status = [
    `${success ? 'PASS' : 'FAIL'} · node --experimental-strip-types --test <${command.files.length} test files>`,
    `exit=${reportedCode}${signal ? ` (signal ${signal})` : ''}${timedOut ? ' (timeout)' : ''} · ${report ? `tests=${report.tests} pass=${report.passed} fail=${report.failed} skipped=${report.skipped} cancelled=${report.cancelled} todo=${report.todo} suites=${report.suites}` : `report=unrecognized (${reportError})`}`,
    `duration=${durationMs}ms · snapshot(start)=${before.value} · snapshot(end)=${ended.value}${snapshotStable ? '' : ' · CHANGED/UNAVAILABLE: result is not bound to a stable worktree'}`,
    `logs: ${reportPath} (full structured report), ${stdoutPath} (test stdout), ${stderrPath} (test stderr), ${runnerStdoutPath} (runner stdout), ${runnerStderrPath} (runner stderr), ${metadataPath} (exact argv)`,
  ];
  let details = '';
  if (report) {
    for (const failure of report.failures) {
      const error = failure.details?.error ?? {};
      const cause = error.cause === undefined ? '' : `cause: ${typeof error.cause === 'string' ? error.cause : JSON.stringify(error.cause)}`;
      const text = [error.name, error.message, error.code ? `code: ${error.code}` : '', error.failureType ? `failureType: ${error.failureType}` : '', error.operator ? `operator: ${error.operator}` : '', cause, error.actual !== undefined ? `actual: ${JSON.stringify(error.actual)}` : '', error.expected !== undefined ? `expected: ${JSON.stringify(error.expected)}` : '', error.stack].filter(Boolean).join('\n');
      const clipped = text.length > 1500 ? `${text.slice(0, 650)}\n… failure detail clipped; see full event report …\n${text.slice(-750)}` : text;
      details += `\nFAIL ${failure.name}\n${clipped}\n`;
    }
    if (!success && report.diagnostics.length) {
      const diagnosticText = report.diagnostics.map((item) => `${item.message ?? ''}`).filter(Boolean).join('\n');
      if (diagnosticText) details += `\nRunner/test stderr diagnostics:\n${diagnosticText.slice(-2500)}\n`;
    }
  }
  if (reportError || reportedCode !== 0) {
    try {
      const stderrText = await readFile(runnerStderrPath, 'utf8');
      if (stderrText.trim()) details += `\nRunner stderr:\n${stderrText.slice(-2500)}\n`;
    } catch (error) {
      details += `\nCould not read runner stderr log: ${error.message}\n`;
    }
    try {
      const eventDiagnostics = (await readFile(reportPath, 'utf8')).split(/\r?\n/).flatMap((line) => {
        try {
          const event = JSON.parse(line);
          if (event.type === 'reporter:error' || event.type === 'test:stderr' || (event.type === 'test:diagnostic' && event.data?.level === 'error')) return [String(event.data?.message ?? '')];
          return [];
        } catch { return []; }
      }).filter(Boolean).join('\n');
      if (eventDiagnostics) details += `\nStructured reporter/test diagnostics:\n${eventDiagnostics.slice(-2500)}\n`;
    } catch {}
  }
  if (spawnError) details += `\nRunner startup error: ${spawnError.message}\n`;
  if (streamError) details += `\nLocal stdout/stderr log write failure: ${streamError.message}\n`;
  const rendered = `${status.join('\n')}${details}`;
  if (rendered.length <= OUTPUT_BUDGET) output.write(`${rendered}\n`);
  else {
    const budgetForDetails = Math.max(0, OUTPUT_BUDGET - status.join('\n').length - 80);
    output.write(`${status.join('\n')}${details.slice(0, budgetForDetails)}\n[summary budget reached; full report: ${reportPath}]\n`);
  }
  return { ok: success, exitCode: success ? 0 : reportedCode || 1, report, summary: rendered, logsDir, command, before, ended };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) process.stdout.write(usage());
    else {
      let timeoutMs = DEFAULT_TIMEOUT_MS;
      const additionalFiles = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--timeout' && args[i + 1]) timeoutMs = parseDuration(args[++i]);
        else if (args[i].startsWith('-')) throw new Error(`Unsupported option: ${args[i]}`);
        else additionalFiles.push(args[i]);
      }
      const result = await runAgentTests({ timeoutMs, additionalFiles });
      if (!result.ok) process.exitCode = result.exitCode;
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage()}`);
    process.exitCode = 2;
  }
}
