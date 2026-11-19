import "server-only";

const runtime = globalThis as typeof globalThis & { __vpmProjectLocks?: Map<string, string> };
const locks = runtime.__vpmProjectLocks ??= new Map<string, string>();

export function projectBusy(path: string): boolean { return locks.has(path); }

/** One mutating operation per canonical directory, shared across route bundles. */
export function lockProject(path: string, operation: string): () => void {
  if (locks.has(path)) throw new Error(`project busy: ${locks.get(path)}`);
  locks.set(path, operation);
  return () => { locks.delete(path); };
}
