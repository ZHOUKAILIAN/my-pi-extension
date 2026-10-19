import { execFileSync } from 'node:child_process';
import { mkdtemp, chmod, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createGitSnapshot } from './git-snapshot.mjs';
import { buildReviewControllerOutputs, formatReviewControllerOutputs } from './review-contract.mjs';
import { githubRequest } from './github-api.mjs';
import { parseOAuthCredential } from './oauth-credential.mjs';
import { appendBlockedSummary, appendCandidateSummary, runUrl } from './review-summary.mjs';
import { validateReviewPreflight } from './review-preflight.mjs';
import { ReviewSpecError, loadReviewSpecification } from './review-spec.mjs';

const repo = process.env.REPOSITORY;
const prNo = process.env.PR_NUMBER;
const context = 'ai-review / result';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_TERMINAL_PROMPT = '0';
process.env.GIT_CONFIG_COUNT = '1';
process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath';
process.env.GIT_CONFIG_VALUE_0 = '/dev/null';
let authDir;
let finalState = 'failure';
const api = (path, options = {}) => githubRequest({ repo, token: process.env.GH_TOKEN, path, options });
const status = async (sha, state, description) => api(`statuses/${sha}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state, context, description: description.slice(0, 140), target_url: runUrl(process.env) }) });
try {
  authDir = await mkdtemp(join(tmpdir(), 'pi-ci-auth-')); await chmod(authDir, 0o700);
  if (!process.env.CI_ENVIRONMENT_TOKEN) throw new Error('Required CI environment token is missing');
  if (!process.env.PI_CI_AUTH_JSON) throw new Error('Required ai-review OAuth secret is missing');
  let oauth;
  try { oauth = parseOAuthCredential(JSON.parse(process.env.PI_CI_AUTH_JSON)); }
  catch { throw new Error('OAuth credential schema invalid'); }
  const publicReportSecrets = [process.env.PI_CI_AUTH_JSON, process.env.GH_TOKEN, process.env.GITHUB_TOKEN, process.env.CI_ENVIRONMENT_TOKEN, process.env.UPDATER_PAT, process.env.UPDATERPAT, oauth.access, oauth.refresh, oauth.accountId];
  for (const value of [process.env.PI_CI_AUTH_JSON, oauth.access, oauth.refresh]) if (value) process.stdout.write(`::add-mask::${value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}\n`);
  await writeFile(join(authDir, 'auth.json'), JSON.stringify({ 'openai-codex': oauth }), { mode: 0o600 });
  await writeFile(join(authDir, 'models.json'), '[]', { mode: 0o600 });
  process.env.PI_CI_AUTH_DIR = authDir;
  process.env.GITHUB_ENV && await writeFile(process.env.GITHUB_ENV, `PI_CI_AUTH_DIR=${authDir}\n`, { flag: 'a', mode: 0o600 });

  const [pr, main] = await Promise.all([api(`pulls/${prNo}`), api('branches/main')]);
  const { head, base } = validateReviewPreflight({ pr, main, repository: repo, expectedHead: process.env.EXPECTED_HEAD, expectedBase: process.env.EXPECTED_BASE, expectedNumber: prNo, dispatch: process.env.DISPATCH === 'true' });
  let spec;
  try { spec = await loadReviewSpecification({ pr, repository: repo, request: (path) => api(path) }); }
  catch (error) {
    const safeMessage = error instanceof ReviewSpecError ? error.message : 'PR or referenced issue specification could not be fetched; review blocked before model invocation.';
    await appendBlockedSummary(safeMessage, process.env, undefined, { knownSecrets: publicReportSecrets });
    throw new Error('Source specification unavailable');
  }
  const snapshot = await createGitSnapshot().create({ base, head, fetchObject: async (...shas) => { execFileSync('git', ['--no-replace-objects','-c','core.hooksPath=/dev/null','fetch','--no-tags','--no-recurse-submodules','origin', ...shas], { stdio: 'ignore' }); }, isAncestor: (ancestor, descendant) => { try { execFileSync('git', ['--no-replace-objects','-c','core.hooksPath=/dev/null','merge-base','--is-ancestor',ancestor,descendant], { stdio: 'ignore' }); return true; } catch { return false; } } });
  if (!snapshot.diff) throw new Error('Empty diff cannot receive a passing review');
  await writeFile(join(authDir, 'snapshot.json'), JSON.stringify({ repo, pr: prNo, spec: { fingerprint: spec.fingerprint, sources: spec.sources, references: spec.references }, ...snapshot, headFiles: [...snapshot.headFiles], baseFiles: [...snapshot.baseFiles] }), { mode: 0o600 });
  const output = execFileSync(process.execPath, [resolve('.github/ai/review.mjs'), join(authDir, 'snapshot.json'), authDir], { encoding: 'utf8', timeout: 35 * 60 * 1000, maxBuffer: 200_000, env: { PATH: process.env.PATH, HOME: authDir, CI: 'true', PI_CODING_AGENT_DIR: authDir, PI_CI_AUTH_DIR: authDir } });
  let result;
  try { result = JSON.parse(output); } catch { throw new Error('Review output was not valid JSON'); }
  const controllerOutputs = buildReviewControllerOutputs(result, { head, base, model: 'openai-codex/gpt-6-astra', changedPaths: snapshot.changedPaths, specFingerprint: spec.fingerprint });
  const fresh = await api(`pulls/${prNo}`); const freshMain = await api('branches/main');
  if (fresh.head.sha !== head || fresh.base.sha !== base || freshMain.commit.sha !== base) throw new Error('PR changed during AI review; stale result discarded');
  const summarySources = spec.sources.map(({ type, id, url, updatedAt }) => ({ type, id, url, updatedAt }));
  await appendCandidateSummary(result, process.env, undefined, { fingerprint: controllerOutputs.specFingerprint, sources: summarySources }, { knownSecrets: publicReportSecrets });
  process.env.GITHUB_OUTPUT && await writeFile(process.env.GITHUB_OUTPUT, formatReviewControllerOutputs(controllerOutputs), { flag: 'a' });
} catch (error) {
  const head = process.env.EXPECTED_HEAD;
  if (head) { try { await status(head, 'failure', 'AI review BLOCKED: authorization, credentials, snapshot, or review failed'); } catch {} }
  process.stderr.write('AI review execution failed; status remains non-success.\n');
  process.exitCode = 1;
}
