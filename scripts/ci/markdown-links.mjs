import { execFileSync } from 'node:child_process';
import { readFile, stat, realpath } from 'node:fs/promises';
import { dirname, resolve, relative, extname, basename } from 'node:path';

export function stripCode(text) {
  let fence = null;
  return text.split(/\r?\n/).map((line) => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1];
    if (marker) { if (!fence) fence = marker[0]; else if (marker[0] === fence) fence = null; return ''; }
    if (fence) return '';
    return line.replace(/(`+)(?!`)([\s\S]*?)(?<!`)\1(?!`)/g, '');
  }).join('\n');
}
export function anchors(text) {
  const result = new Set(); const counts = new Map();
  const body = text.split(/\r?\n/); let fence = null;
  for (const line of body) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1];
    if (marker) { if (!fence) fence = marker[0]; else if (marker[0] === fence) fence = null; continue; }
    if (fence) continue;
    const explicit = stripCode(line).match(/<a\s+id=["']([^"']+)["']/i)?.[1]; if (explicit) result.add(explicit);
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)?.[1];
    if (!heading) continue;
    const slug = heading.toLowerCase().replace(/<[^>]*>/g, '').replace(/[`*_~]/g, '').replace(/[^\p{L}\p{N}\p{M}\s-]/gu, '').trim().replace(/\s/g, '-');
    const n = counts.get(slug) ?? 0; counts.set(slug, n + 1); result.add(n ? `${slug}-${n}` : slug);
  }
  return result;
}
function normalizeAnchor(value) { return value.toLowerCase(); }
export async function checkMarkdown(root = process.cwd()) {
  const files = execFileSync('git', ['ls-files', '-z', '--', '*.md'], { cwd: root }).toString().split('\0').filter(Boolean);
  const contents = new Map(await Promise.all(files.map(async (f) => [f, await readFile(resolve(root, f), 'utf8')])));
  const failures = [];
  for (const [file, text] of contents) {
    const body = stripCode(text); const refs = new Map();
    for (const m of body.matchAll(/^\s*\[([^\]]+)\]:\s*<?([^\s>]+)>?/gm)) refs.set(m[1].toLowerCase(), m[2]);
    const targets = [];
    for (const m of body.matchAll(/!?\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g)) targets.push(m[1].replace(/^<|>$/g, '').trim());
    for (const m of body.matchAll(/^\s*\[([^\]]+)\]:\s*<?([^\s>]+)>?/gm)) targets.push(m[2]);
    for (const m of body.matchAll(/\[[^\]]+\]\[([^\]]+)\]/g)) { const target = refs.get(m[1].toLowerCase()); if (target) targets.push(target); }
    for (const raw of targets) {
      if (/^(?:https?:|mailto:|data:|javascript:)/i.test(raw)) continue;
      const hashIndex = raw.indexOf('#'); const queryIndex = raw.indexOf('?');
      const cut = [hashIndex, queryIndex].filter((n) => n >= 0).reduce((a, b) => Math.min(a, b), raw.length);
      let target, hash;
      try { target = decodeURIComponent(raw.slice(0, cut)); hash = hashIndex >= 0 ? decodeURIComponent(raw.slice(hashIndex + 1, queryIndex > hashIndex ? queryIndex : undefined)) : ''; }
      catch { failures.push(`${file}: invalid URL encoding ${raw}`); continue; }
      const resolved = target.startsWith('/') ? resolve(root, `.${target}`) : resolve(root, dirname(file), target || basename(file));
      const rel = relative(root, resolved);
      if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) { failures.push(`${file}: path escapes repository: ${raw}`); continue; }
      try {
        await stat(resolved);
        const actual = await realpath(resolved); const actualRel = relative(await realpath(root), actual);
        if (actualRel === '..' || actualRel.startsWith(`..${process.platform === 'win32' ? '\\\\' : '/'}`)) { failures.push(`${file}: symlink target escapes repository: ${raw}`); continue; }
      } catch { failures.push(`${file}: missing relative target ${raw}`); continue; }
      if (hash && extname(resolved).toLowerCase() === '.md') {
        const targetFile = relative(root, resolved); const targetText = contents.get(targetFile) ?? await readFile(resolved, 'utf8');
        if (![...anchors(targetText)].some((anchor) => normalizeAnchor(anchor) === normalizeAnchor(hash))) failures.push(`${file}: missing anchor #${hash} in ${targetFile}`);
      } else if (hash && !target && ![...anchors(text)].some((anchor) => normalizeAnchor(anchor) === normalizeAnchor(hash))) failures.push(`${file}: missing local anchor #${hash}`);
    }
  }
  return failures;
}
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const failures = await checkMarkdown();
  if (failures.length) { for (const failure of failures) console.error(failure); process.exitCode = 1; }
  else console.log(`Markdown links: ${execFileSync('git', ['ls-files', '--', '*.md']).toString().trim().split('\n').filter(Boolean).length} tracked files checked`);
}
