// Thin adapter from a Cloudflare D1 binding to the SqlDatabase interface used by the store.
// Structural only — no @cloudflare/workers-types dependency is required by this slice.

import type { BatchStatement, SqlDatabase, SqlRow, SqlValue, Statement } from './store.ts';

interface D1StatementLike {
  bind(...params: unknown[]): {
    run(): Promise<{ meta?: { changes?: number; last_row_id?: number } }>;
    first(): Promise<unknown | null>;
    all(): Promise<{ results?: unknown[] }>;
  };
}

interface D1Like {
  prepare(sql: string): D1StatementLike;
  // Cloudflare D1 batch: every statement executes sequentially inside one implicit transaction —
  // a failing statement rolls the whole batch back. This is the atomic multi-statement unit used
  // by the store's publication write (pointer + history, review P1.1).
  batch(statements: unknown[]): Promise<Array<{ meta?: { changes?: number; last_row_id?: number } }>>;
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
    async transaction(statements: BatchStatement[]): Promise<number[]> {
      const prepared = statements.map((s) => d1.prepare(s.sql).bind(...s.params.map(toSqlValue)));
      const results = await d1.batch(prepared);
      return results.map((r) => r.meta?.changes ?? 0);
    },
  };
}