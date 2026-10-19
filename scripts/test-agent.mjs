import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runCli } from 'node-test-brief/cli';
import { buildNodeTestCommand, repoRoot } from './test-suite.mjs';

function helpArgumentPrefix(argv) {
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--') return undefined;
    if (argument === '--help' || argument === '-h') return argv.slice(0, index + 1);
    if (argument === '--timeout' || argument === '--snapshot') {
      if (index + 1 >= argv.length) return undefined;
      index++;
    }
  }
  return undefined;
}

export async function runAgentTests({ argv = process.argv.slice(2), root = repoRoot } = {}) {
  const metricsConfig = process.env.PI_METRICS_CONFIG;
  const isolatedRoot = mkdtempSync(join(tmpdir(), 'pi-agent-test-'));
  const environmentKeys = ['HOME', 'PI_CODING_AGENT', 'PI_MODEL', 'PI_PROVIDER', 'PI_REASONING_LEVEL', 'PI_SESSION_FILE', 'PI_SESSION_ID', 'PI_CODING_AGENT_DIR', 'PI_MY_EXTENSIONS_SETTINGS_FILE', 'PI_METRICS_CONFIG'];
  const environmentSnapshot = new Map(environmentKeys.map(key => [key, process.env[key]]));
  process.env.HOME = isolatedRoot;
  process.env.PI_CODING_AGENT_DIR = join(isolatedRoot, 'agent');
  // Clear the internal override so every fixture that changes PI_CODING_AGENT_DIR
  // remains authoritative; the effective agent root is still synthetic.
  delete process.env.PI_MY_EXTENSIONS_SETTINGS_FILE;
  for (const key of environmentKeys.filter(key => !['HOME', 'PI_CODING_AGENT_DIR'].includes(key))) delete process.env[key];
  try {
    let exitCode;
    const helpArgv = helpArgumentPrefix(argv);
    if (helpArgv) {
      const quiet = { write() {} };
      const helpExitCode = await runCli({ argv: helpArgv, cwd: root, files: [], nodeArgs: [], snapshot: 'git', output: quiet, errorOutput: quiet });
      if (helpExitCode === 0) exitCode = await runCli({ argv: helpArgv, cwd: root, files: [], nodeArgs: [], snapshot: 'git' });
    }
    if (exitCode === undefined) {
      const command = await buildNodeTestCommand({ root, rejectTestHooks: true });
      if (argv.length > 0) {
        // Preserve the adapter contract for explicit CLI arguments and extra
        // files: installed consumers receive the complete discovered scope in
        // one invocation.
        exitCode = await runCli({ argv, cwd: root, files: command.files, nodeArgs: command.nodeArgs, snapshot: 'git' });
      } else {
        exitCode = 0;
        // The extension suite exercises process.env-backed SDK configuration;
        // each normal suite file therefore runs in a fresh Node process.
        for (const file of command.files) {
          const result = await runCli({ argv, cwd: root, files: [file], nodeArgs: command.nodeArgs, snapshot: 'git' });
          if (result !== 0) { exitCode = result; break; }
        }
      }
    }
    if (exitCode !== 0) process.exitCode = exitCode;
    return exitCode;
  } finally {
    for (const key of environmentKeys) {
      const value = environmentSnapshot.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runAgentTests(); }
  catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
