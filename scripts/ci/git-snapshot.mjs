import { execFileSync } from 'node:child_process';
const SHA = /^[0-9a-f]{40}$/i;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*[\u0000-\u001f\u007f])[\s\S]+$/u;
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null', GIT_CONFIG_KEY_1: 'core.autocrlf', GIT_CONFIG_VALUE_1: 'false', GIT_CONFIG_KEY_2: 'core.attributesFile', GIT_CONFIG_VALUE_2: '/dev/null' };
export function createGitSnapshot({ run = execFileSync, root = process.cwd(), maxFileBytes = 1_000_000, maxTotalBytes = 8_000_000, maxDiffBytes = 8_000_000 } = {}) {
  const git = (args, binary = false) => run('git', ['--no-replace-objects','-c','core.hooksPath=/dev/null','-c','core.autocrlf=false','-c','core.attributesFile=/dev/null', ...args], { cwd: root, env, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore','pipe','ignore'], encoding: binary ? 'buffer' : 'utf8' });
  const tree = (sha) => {
    if (!SHA.test(sha)) throw new Error('Invalid commit SHA');
    const output = git(['ls-tree','-rz','--full-tree','-r',sha]);
    const files = new Map(); let total = 0;
    for (const entry of output.split('\0').filter((item) => item.length > 0)) {
      const tab = entry.indexOf('\t');
      if (tab < 0) throw new Error('Malformed tree entry');
      const [mode, type, oid] = entry.slice(0, tab).split(' '); const path = entry.slice(tab + 1);
      if (!SAFE_PATH.test(path) || type !== 'blob' || !['100644','100755'].includes(mode) || !SHA.test(oid)) throw new Error(`Unsupported tree entry: ${path}`);
      const sizeText = git(['cat-file','-s',oid]);
      if (!/^\d+\n?$/.test(sizeText)) throw new Error('Invalid blob size response');
      const size = Number(sizeText.trim());
      if (size > maxFileBytes || total + size > maxTotalBytes) throw new Error(`Snapshot budget exceeded: ${path}`);
      const bytes = git(['cat-file','blob',oid], true);
      if (bytes.length !== size || bytes.includes(0)) throw new Error(`Binary or inconsistent blob: ${path}`);
      let content; try { content = new TextDecoder('utf-8',{fatal:true}).decode(bytes); } catch { throw new Error(`Non-UTF-8 blob: ${path}`); }
      files.set(path, content); total += size;
    }
    return files;
  };
  return {
    async create({ base, head, isAncestor, fetchObject } = {}) {
      if (!SHA.test(base ?? '') || !SHA.test(head ?? '')) throw new Error('Commit IDs must be full 40-character SHAs');
      await fetchObject?.(base, head);
      if (!isAncestor(base, head)) throw new Error('Base is not an ancestor of head');
      const baseFiles = tree(base), headFiles = tree(head);
      const diff = git(['-c','diff.external=','diff','--no-ext-diff','--no-textconv','--no-renames','--binary',`${base}...${head}`]);
      if (Buffer.byteLength(diff) > maxDiffBytes) throw new Error('Diff snapshot budget exceeded');
      const changedRaw = git(['-c','diff.external=','diff','--name-only','-z','--no-ext-diff','--no-textconv','--no-renames',`${base}...${head}`]);
      const changedPaths = changedRaw.split('\0').filter(Boolean);
      if (changedPaths.some((p) => !SAFE_PATH.test(p))) throw new Error('Unsafe changed path');
      return { base, head, baseFiles, headFiles, diff, changedPaths };
    },
  };
}
