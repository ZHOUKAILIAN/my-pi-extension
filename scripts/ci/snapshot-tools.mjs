const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*[\u0000-\u001f\u007f])[\s\S]+$/u;
const PAGE_SIZE = 200;
const lineList = (text) => text.split('\n');
export function createSnapshotTools({ headFiles, baseFiles, diff, axis }) {
  if (!(headFiles instanceof Map) || !(baseFiles instanceof Map) || !['five-layer consistency','code review'].includes(axis)) throw new Error('Invalid snapshot tool input');
  const diffLines = lineList(diff);
  const readPages = [];
  const truncationDebts = new Map();
  const completeReads = new Set();
  const coverageErrors = [];
  const maxOutputBytes = 512_000;
  const bounded = (value, label) => {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maxOutputBytes) {
      coverageErrors.push(`${axis}: ${label} exceeded the ${maxOutputBytes}-byte tool output limit`);
      throw new Error('Snapshot tool response budget exceeded');
    }
    return value;
  };
  const assertPath = (path) => { if (typeof path !== 'string' || !SAFE_PATH.test(path) || ['__proto__','constructor','prototype'].includes(path)) throw new Error('Unsafe snapshot path'); };
  const page = (items, cursor = 0, size = PAGE_SIZE) => {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(size) || size < 1 || size > PAGE_SIZE) throw new Error('Invalid page request');
    return { items: items.slice(cursor, cursor + size), total: items.length, nextCursor: cursor + size < items.length ? cursor + size : null };
  };
  return {
    list({ version = 'head', prefix = '', cursor = 0, size = PAGE_SIZE } = {}) {
      if (!['head','base'].includes(version)) throw new Error('Invalid snapshot version');
      const paths = [...(version === 'head' ? headFiles : baseFiles).keys()].filter((p) => p.startsWith(prefix)).sort();
      return bounded(page(paths, cursor, size), 'list response');
    },
    read({ path, version = 'head', start = 1, count = 200 }) {
      assertPath(path);
      if (!['head','base'].includes(version) || !Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(count) || count < 1 || count > PAGE_SIZE) throw new Error('Invalid snapshot read request');
      const files = version === 'head' ? headFiles : baseFiles;
      if (!files.has(path)) return { unavailable: true };
      const lines = lineList(files.get(path));
      const selected = lines.slice(start - 1, start - 1 + count);
      if (selected.some((line) => line.length > 16_000)) {
        coverageErrors.push(`${axis}: ${version} file ${path} contains a line that exceeds the readable line limit`);
        throw new Error('Snapshot line exceeds the readable limit');
      }
      const response = bounded({ lines: selected.map((text, i) => `${start + i}: ${text}`), totalLines: lines.length, nextStart: start - 1 + count < lines.length ? start + count : null }, 'file response');
      selected.forEach((_text, index) => {
        const line = start + index;
        const key = JSON.stringify([version, path, line]);
        completeReads.add(key);
        truncationDebts.delete(key);
      });
      return response;
    },
    search({ query, prefix = '', version = 'head', cursor = 0, size = PAGE_SIZE } = {}) {
      if (typeof query !== 'string' || !query || query.length > 200 || !['head','base'].includes(version)) throw new Error('Invalid snapshot search');
      if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(size) || size < 1 || size > PAGE_SIZE) throw new Error('Invalid page request');
      const files = version === 'head' ? headFiles : baseFiles;
      const items = []; let total = 0; let hasTruncatedHits = false;
      for (const [path, text] of files) if (path.startsWith(prefix)) {
        const lines = lineList(text);
        for (let i = 0; i < lines.length; i++) if (lines[i].toLowerCase().includes(query.toLowerCase())) {
          if (total >= cursor && items.length < size) {
            const truncated = lines[i].length > 2000;
            hasTruncatedHits ||= truncated;
            const line = i + 1;
            const key = JSON.stringify([version, path, line]);
            if (truncated && !completeReads.has(key)) truncationDebts.set(key, `${axis}: truncated ${version} search hit needs full read at ${path}:${line}`);
            items.push({ path, line, text: lines[i].slice(0, 2000), truncated });
          }
          total++;
        }
      }
      return bounded({ items, total, nextCursor: cursor + items.length < total ? cursor + items.length : null, hasTruncatedHits }, 'search response');
    },
    diff({ start = 1, count = 200 } = {}) {
      if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(count) || count < 1 || count > PAGE_SIZE) throw new Error('Invalid diff page');
      const selected = diffLines.slice(start - 1, start - 1 + count);
      if (selected.some((line) => line.length > 16_000)) {
        coverageErrors.push(`${axis}: diff page includes a line exceeding the readable limit`);
        throw new Error('Diff line exceeds the readable limit');
      }
      const result = bounded({ lines: selected.map((text, i) => `${start + i}: ${text}`), totalLines: diffLines.length, nextStart: start - 1 + count < diffLines.length ? start + count : null }, 'diff response');
      readPages.push([start, Math.min(start + count - 1, diffLines.length)]);
      return result;
    },
    markCoverageError(message) { coverageErrors.push(`${axis}: ${message}`); },
    coverageErrors() { return [...coverageErrors]; },
    coverageGaps() {
      const covered = new Set();
      for (const [start, end] of readPages) for (let n = start; n <= end; n++) covered.add(n);
      const missing = [];
      for (let n = 1; n <= diffLines.length; n++) if (!covered.has(n)) missing.push(n);
      const gaps = missing.length ? [`${axis}: diff lines not read (${missing.length}; first ${missing.slice(0, 20).join(',')})`] : [];
      return [...gaps, ...truncationDebts.values()];
    },
  };
}
