/**
 * Minimal ambient types for node:sqlite.
 *
 * The installed @types/node (v20) predates node:sqlite, and upgrading the whole
 * toolchain is not worth it for one module. These declarations cover exactly the
 * surface lib/db.ts uses. On a newer @types/node this file is simply redundant
 * and can be deleted.
 */

declare module "node:sqlite" {
  export interface StatementSync {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): {
      changes: number | bigint;
      lastInsertRowid: number | bigint;
    };
    iterate(...params: unknown[]): IterableIterator<unknown>;
  }

  export class DatabaseSync {
    constructor(location: string, options?: { open?: boolean; readOnly?: boolean });
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    open(): void;
  }
}
