function normalize(value, seen = new WeakMap(), depth = 0) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'bigint') return { $type: 'bigint', value: value.toString() };
  if (typeof value === 'undefined') return undefined;
  if (typeof value === 'symbol' || typeof value === 'function') return `[${typeof value}: ${String(value)}]`;
  if (depth > 8) return '[maximum detail depth reached]';
  if (seen.has(value)) return '[circular or repeated reference]';
  seen.set(value, true);
  if (value instanceof Error) {
    return {
      $type: 'Error', name: normalize(value.name, seen, depth + 1), message: normalize(value.message, seen, depth + 1), stack: normalize(value.stack, seen, depth + 1),
      code: normalize(value.code, seen, depth + 1), failureType: normalize(value.failureType, seen, depth + 1), operator: normalize(value.operator, seen, depth + 1),
      actual: normalize(value.actual, seen, depth + 1), expected: normalize(value.expected, seen, depth + 1),
      cause: normalize(value.cause, seen, depth + 1),
      details: {
        ...Object.fromEntries(Object.keys(value).slice(0, 40).map((key) => [key, normalize(value[key], seen, depth + 1)])),
        ...(Object.keys(value).length > 40 ? { $truncatedProperties: Object.keys(value).length - 40 } : {}),
      },
    };
  }
  if (Array.isArray(value)) {
    const values = value.slice(0, 100).map((item) => normalize(item, seen, depth + 1));
    if (value.length > 100) values.push({ $truncatedItems: value.length - 100 });
    return values;
  }
  if (Buffer.isBuffer(value)) {
    const clipped = value.length > 3072;
    return { $type: 'Buffer', base64: value.subarray(0, 3072).toString('base64'), ...(clipped ? { $truncatedBytes: value.length - 3072 } : {}) };
  }
  if (value instanceof Map) {
    const entries = [...value.entries()].slice(0, 100).map(([key, item]) => [normalize(key, seen, depth + 1), normalize(item, seen, depth + 1)]);
    return { $type: 'Map', entries, ...(value.size > 100 ? { $truncatedEntries: value.size - 100 } : {}) };
  }
  if (value instanceof Set) {
    const values = [...value].slice(0, 100).map((item) => normalize(item, seen, depth + 1));
    return { $type: 'Set', values, ...(value.size > 100 ? { $truncatedItems: value.size - 100 } : {}) };
  }
  const result = {};
  let keys;
  try { keys = Object.keys(value); }
  catch { return '[uninspectable object]'; }
  for (const key of keys.slice(0, 100)) {
    try { result[key] = normalize(value[key], seen, depth + 1); }
    catch { result[key] = '[unreadable property]'; }
  }
  if (keys.length > 100) result.$truncatedProperties = keys.length - 100;
  return result;
}

export default async function* (events) {
  const params = new URL(import.meta.url).searchParams;
  let stdoutLog;
  let stderrLog;
  const failSink = params.get('failSink');
  const failDelayMs = Number(params.get('failDelayMs') ?? 0);
  const maybeFail = async (sink) => {
    if (failSink === sink) {
      if (failDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, failDelayMs));
      throw new Error(`Injected ${sink} log write failure`);
    }
  };
  try {
    stdoutLog = await import('node:fs/promises').then(({ open }) => open(params.get('stdout'), 'w', 0o600));
    stderrLog = await import('node:fs/promises').then(({ open }) => open(params.get('stderr'), 'w', 0o600));
    for await (const event of events) {
      const data = event?.data;
      if (event.type === 'test:stdout' && typeof data?.message === 'string') {
        await maybeFail('test-stdout');
        await stdoutLog.writeFile(data.message);
      }
      if (event.type === 'test:stderr' && typeof data?.message === 'string') {
        await maybeFail('test-stderr');
        await stderrLog.writeFile(data.message);
      }
      if (event.type === 'test:stdout' || event.type === 'test:stderr') await maybeFail('events');
      yield `${JSON.stringify(normalize(event))}\n`;
    }
  } catch (error) {
    yield `${JSON.stringify({ type: 'reporter:error', data: { message: `Could not write complete test output: ${error.message}` } })}\n`;
    throw error;
  } finally {
    await Promise.allSettled([stdoutLog?.close(), stderrLog?.close()].filter(Boolean));
  }
}
