const PAGE_LINES = 200;
const MAX_RESPONSE_BYTES = 512_000;
export function createReviewSpecTools(sources) {
  if (!Array.isArray(sources) || sources.length === 0) throw new Error('At least one source specification is required');
  const byId = new Map(sources.map((source) => [source.id, source]));
  const pages = new Map();
  const errors = [];
  const bounded = (value) => {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_RESPONSE_BYTES) {
      errors.push('Source specification page exceeded the tool response budget.');
      throw new Error('Source specification response budget exceeded');
    }
    return value;
  };
  return {
    list() {
      return sources.map(({ id, type, number, title, url, updatedAt, content }) => ({ id, type, number, title, url, updatedAt, totalLines: content.split('\n').length }));
    },
    read({ sourceId, start = 1, count = 100 }) {
      if (typeof sourceId !== 'string' || !byId.has(sourceId) || !Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(count) || count < 1 || count > PAGE_LINES) throw new Error('Invalid source specification page request');
      const source = byId.get(sourceId);
      const lines = source.content.split('\n');
      const selected = lines.slice(start - 1, start - 1 + count);
      const page = bounded({ source: { id: source.id, type: source.type, number: source.number, title: source.title, url: source.url, updatedAt: source.updatedAt }, start, end: start + selected.length - 1, totalLines: lines.length, nextStart: start - 1 + count < lines.length ? start + count : null, lines: selected.map((text, i) => `${start + i}: ${text}`) });
      if (selected.length) {
        const ranges = pages.get(sourceId) ?? [];
        ranges.push([start, start + selected.length - 1]);
        pages.set(sourceId, ranges);
      }
      return page;
    },
    coverageGaps() {
      const gaps = [];
      for (const source of sources) {
        const total = source.content.split('\n').length;
        const covered = new Set();
        for (const [start, end] of pages.get(source.id) ?? []) for (let line = start; line <= end; line++) covered.add(line);
        const missing = [];
        for (let line = 1; line <= total; line++) if (!covered.has(line)) missing.push(line);
        if (missing.length) gaps.push(`Source ${source.id} not fully read: ${missing.length} lines missing (first ${missing.slice(0, 20).join(',')}).`);
      }
      return gaps;
    },
    errors() { return [...errors]; },
    coverageRecords() {
      if (errors.length || this.coverageGaps().length) return [];
      return sources.map((source) => ({ source: 'spec', path: source.id, start: 1, end: source.content.split('\n').length, note: 'source requirement fully read' }));
    },
  };
}
