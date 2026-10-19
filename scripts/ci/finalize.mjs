import { appendFile } from 'node:fs/promises';
import { finalizeReview } from './review-lifecycle.mjs';
import { githubRequest } from './github-api.mjs';
import { appendFinalSummary, runUrl } from './review-summary.mjs';
import { loadReviewSpecification } from './review-spec.mjs';
const repo = process.env.REPOSITORY;
const head = process.env.EXPECTED_HEAD;
const summaryOptions = { knownSecrets: [process.env.GH_TOKEN, process.env.GITHUB_TOKEN, process.env.CI_ENVIRONMENT_TOKEN, process.env.UPDATER_PAT, process.env.UPDATERPAT] };
const api = (path, options = {}) => githubRequest({ repo, token: process.env.GH_TOKEN, path, options });
try {
  const outcome = await finalizeReview({
    outcomes: { authorization: process.env.AUTH_OUTCOME, install: process.env.INSTALL_OUTCOME, review: process.env.RUN_OUTCOME, save: process.env.SAVE_OUTCOME, result: process.env.REVIEW_RESULT },
    expected: { head, base: process.env.EXPECTED_BASE, specFingerprint: process.env.SPEC_FINGERPRINT },
    readCurrent: async () => {
      const [pr, main] = await Promise.all([api(`pulls/${process.env.PR_NUMBER}`), api('branches/main')]);
      if (pr.base?.ref !== 'main') throw new Error('PR base is no longer main');
      const spec = await loadReviewSpecification({ pr, repository: repo, request: (path) => api(path) });
      return { head: pr.head?.sha, base: pr.base?.sha, main: main.commit?.sha, specFingerprint: spec.fingerprint };
    },
    publishSuccess: async (sha) => {
      const response = await api(`statuses/${sha}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: 'success', context: 'ai-review / result', description: 'AI review PASSED: both axes and credential persistence completed', target_url: runUrl(process.env) }) });
      if (!response.url) throw new Error('GitHub did not confirm status creation');
    },
    beforePublish: async () => appendFinalSummary('publishing', process.env, undefined, summaryOptions),
    publishFailure: async (sha) => {
      await api(`statuses/${sha}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: 'failure', context: 'ai-review / result', description: 'AI review BLOCKED: workflow, review, persistence, or freshness check failed', target_url: runUrl(process.env) }) });
    },
  });
  if (!outcome.finalized) {
    await appendFinalSummary('failure', process.env, undefined, summaryOptions);
    throw new Error(outcome.reason);
  }
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'finalized=true\n');
} catch {
  try {
    if (head && process.env.GH_TOKEN) await api(`statuses/${head}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: 'failure', context: 'ai-review / result', description: 'AI review finalization failed', target_url: runUrl(process.env) }) });
  } catch { /* Pending is safer than relying on an uncertain success response. */ }
  try { await appendFinalSummary('failure', process.env, undefined, summaryOptions); } catch { /* Summary availability does not affect fail-closed status behavior. */ }
  process.stderr.write('AI review finalization blocked; status remains pending or failed.\n');
  process.exitCode = 1;
}
