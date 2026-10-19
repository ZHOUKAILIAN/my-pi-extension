const SHA = /^[0-9a-f]{40}$/i;
export function validateReviewPreflight({ pr, main, repository, expectedHead, expectedBase, expectedNumber, dispatch }) {
  const owner = repository?.split('/')[0];
  const head = pr?.head?.sha;
  const base = pr?.base?.sha;
  const headOwner = pr?.head?.repo?.owner?.login;
  const headName = pr?.head?.repo?.name;
  const headRepo = pr?.head?.repo?.full_name?.toLowerCase();
  const baseOwner = pr?.base?.repo?.owner?.login;
  const baseName = pr?.base?.repo?.name;
  const baseRepo = pr?.base?.repo?.full_name?.toLowerCase();
  if (pr?.state !== 'open' || !Number.isSafeInteger(pr.number) || !owner || !SHA.test(head ?? '') || !SHA.test(base ?? '') || !SHA.test(main?.commit?.sha ?? '')) throw new Error('PR is not open or commit/repository metadata is invalid');
  if (expectedNumber !== undefined && pr.number !== Number(expectedNumber) || head !== expectedHead || base !== expectedBase || main.commit.sha !== expectedBase || pr.base.ref !== 'main' || baseRepo !== repository.toLowerCase() || baseRepo !== `${baseOwner}/${baseName}`.toLowerCase()) throw new Error('PR head/base binding is stale');
  if (!headOwner || !headName || headRepo !== `${headOwner}/${headName}`.toLowerCase()) throw new Error('PR head repository binding invalid');
  if (!dispatch && (pr.user?.login?.toUpperCase() !== owner.toUpperCase() || headRepo !== repository.toLowerCase())) {
    throw new Error('Automatic review requires owner-authored same-repository PR');
  }
  return { head, base };
}
