// Thin adapter from a Cloudflare D1 binding to the SqlDatabase interface used by the store.
// Structural only — no @cloudflare/workers-types dependency is required by this slice.

import type { SqlDatabase, SqlRow, SqlValue, Statement } from './store.ts';

interface D1StatementLike {
  bind(...params: unknown[]): {
    run(): Promise<{ meta?: { changes?: number; last_row_id?: number } }>;
    first(): Promise<unknown | null>;
    all(): Promise<{ results?: unknown[] }>;
  };
}

interface D1Like {
  prepare(sql: string): D1StatementLike;
}

function toSqlValue(v: unknown): SqlValue {
  if (typeof v === 'string' || typeof v === 'number' || v === null || typeof v === 'bigint') return v;
  return String(v);
}

export function adaptD1(db: unknown): SqlDatabase {
  const d1 = db as D1Like;
  return {
    prepare(sql: string): Statement {
      const stmt = d1.prepare(sql);
      return {
        async run(...params: SqlValue[]): Promise<{ changes: number }> {
          const res = await stmt.bind(...params).run();
          return { changes: res.meta?.changes ?? 0 };
        },
        async first<T extends SqlRow>(...params: SqlValue[]): Promise<T | undefined> {
          const res = await stmt.bind(...params).first();
          return res === null || res === undefined ? undefined : (res as T);
        },
        async all<T extends SqlRow>(...params: SqlValue[]): Promise<T[]> {
          const res = await stmt.bind(...params.map(toSqlValue)).all();
          return (res.results ?? []) as T[];
        },
      };
    },
  };
}