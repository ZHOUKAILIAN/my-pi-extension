export async function githubRequest({ fetchImpl = fetch, repo, token, path, options = {} }) {
  const response = await fetchImpl(`https://api.github.com/repos/${repo}/${path}`, { ...options, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...options.headers } });
  if (!Number.isInteger(response.status) || !response.ok) throw new Error(`GitHub API ${response.status}`);
  let body;
  try { body = await response.json(); } catch { throw new Error('Invalid GitHub API JSON body'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid GitHub API response body');
  if (Object.hasOwn(body, 'status') && String(body.status) !== String(response.status)) throw new Error('GitHub API response status/header mismatch');
  return body;
}
