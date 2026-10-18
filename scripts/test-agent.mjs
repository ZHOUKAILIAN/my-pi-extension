import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
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
  delete process.env.PI_METRICS_CONFIG;
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
      exitCode = await runCli({
        argv,
        cwd: root,
        files: command.files,
        nodeArgs: command.nodeArgs,
        snapshot: 'git',
      });
    }
    if (exitCode !== 0) process.exitCode = exitCode;
    return exitCode;
  } finally {
    if (metricsConfig === undefined) delete process.env.PI_METRICS_CONFIG;
    else process.env.PI_METRICS_CONFIG = metricsConfig;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runAgentTests(); }
  catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
