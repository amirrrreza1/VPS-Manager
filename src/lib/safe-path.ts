import path from "node:path";
import fs from "node:fs";
import { envRoots } from "./roots";
import { IGNORED_DIRS } from "./config";

/**
 * Every filesystem access in this app funnels through here.
 *
 * The threat: a path like "../../etc/shadow" or "/opt/link-to-etc/passwd" or
 * "C:\\Windows\\system32". Three defences, applied in order:
 *   1. lexical  - reject NUL bytes, normalize, strip traversal
 *   2. realpath - resolve symlinks on the deepest EXISTING ancestor, so a
 *                 symlink pointing outside the root is caught even when the
 *                 final component does not exist yet (create/rename targets)
 *   3. boundary - the resolved real path must be inside an allowed root,
 *                 compared with path.relative so /opt-evil never passes as /opt
 */

export class PathError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "PathError";
    this.status = status;
  }
}

function roots(): string[] {
  return envRoots().map((r) => path.resolve(r));
}

function rootRealpaths(): string[] {
  const out: string[] = [];
  for (const r of roots()) {
    try {
      out.push(fs.realpathSync.native(r));
    } catch {
      // A configured root that does not exist yet cannot contain anything.
      // Skip rather than fail: it simply matches nothing.
    }
  }
  return out;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (rel === "") return true;
  if (rel.startsWith("..")) return false;
  return !path.isAbsolute(rel);
}

/**
 * Deepest existing ancestor of `p`, realpath'd, with the non-existent tail
 * re-appended. Lets us validate a path for creation where the leaf is absent.
 */
function realpathOfNearestExisting(p: string): string {
  const tail: string[] = [];
  let current = p;
  // Bounded: stop at filesystem root.
  for (let i = 0; i < 4096; i++) {
    try {
      const real = fs.realpathSync.native(current);
      return tail.length ? path.join(real, ...tail) : real;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const parent = path.dirname(current);
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        // EACCES/ELOOP etc - we cannot prove this path is safe, so refuse.
        throw new PathError(`cannot resolve path: ${code}`, 400);
      }
      if (parent === current) {
        throw new PathError("path escapes filesystem root", 400);
      }
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
  throw new PathError("path too deep", 400);
}

/**
 * Resolve a user-supplied path against a root and prove it stays inside.
 *
 * @param input     user-supplied absolute-or-relative path
 * @param baseRoot  optional root to resolve against; defaults to trying every
 *                  configured root (the first that contains it wins)
 * @param opts.allowMissingLeaf  permit a non-existent final component (create)
 * @param opts.mustExist         require the final component to exist
 */
export function resolveSafe(
  input: string,
  baseRoot?: string,
  opts: { allowMissingLeaf?: boolean; mustExist?: boolean } = {},
): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new PathError("path required");
  }
  if (input.includes("\0")) {
    throw new PathError("path contains NUL byte");
  }
  if (input.length > 4096) {
    throw new PathError("path too long");
  }

  const candidates = baseRoot
    ? [path.resolve(baseRoot)]
    : roots();

  let lastError: PathError | null = null;

  for (const root of candidates) {
    let realRoot: string;
    try {
      realRoot = fs.realpathSync.native(root);
    } catch {
      lastError = new PathError(`root unavailable: ${root}`, 404);
      continue;
    }

    // Treat the root as a virtual CWD: a relative path, or a path under the
    // root, both resolve inside it. Anything else is out of bounds.
    const relativeish = input.startsWith(root) || input.startsWith("/") || path.isAbsolute(input);
    const joined = relativeish
      ? path.resolve(realRoot, input.replace(/^[/\\]+/, ""))
      : path.resolve(realRoot, input);

    let resolved: string;
    try {
      resolved = realpathOfNearestExisting(joined);
    } catch (e) {
      lastError = e instanceof PathError ? e : new PathError("unresolvable path");
      continue;
    }

    // Defence 3: boundary containment against the REAL root.
    if (!isInside(realRoot, resolved)) {
      lastError = new PathError("path escapes allowed roots", 403);
      continue;
    }

    const leafExists = fs.existsSync(resolved);
    if (opts.mustExist && !leafExists) {
      lastError = new PathError("not found", 404);
      continue;
    }
    if (!opts.allowMissingLeaf && !leafExists && !opts.mustExist) {
      // Default: caller asked for something that must be there.
      lastError = new PathError("not found", 404);
      continue;
    }

    return resolved;
  }

  throw lastError ?? new PathError("path not permitted", 403);
}

/** Resolve a path and require it to be an existing file. */
export function resolveFile(input: string, baseRoot?: string): string {
  return resolveSafe(input, baseRoot, { mustExist: true });
}

/** Resolve a path and require it to be an existing directory. */
export function resolveDir(input: string, baseRoot?: string): string {
  const p = resolveFile(input, baseRoot);
  if (!fs.statSync(p).isDirectory()) {
    throw new PathError("not a directory", 400);
  }
  return p;
}

/** Resolve a path whose final component need not exist yet. */
export function resolveForWrite(input: string, baseRoot?: string): string {
  const p = resolveSafe(input, baseRoot, { allowMissingLeaf: true, mustExist: false });
  const parent = path.dirname(p);
  if (!fs.existsSync(parent)) {
    throw new PathError("parent directory does not exist", 404);
  }
  return p;
}

export interface DirEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  mtimeMs: number;
  /** True when the symlink resolves outside the allowed roots. */
  escaping?: boolean;
  broken?: boolean;
}

/** List a directory safely. Symlinks that escape the root are flagged, not followed. */
export function listDir(dir: string, opts: { showHidden?: boolean } = {}): DirEntry[] {
  const realDir = resolveDir(dir);
  const realRoot = enclosingRoot(realDir);
  const showHidden = opts.showHidden ?? true;

  const names = fs.readdirSync(realDir);
  const entries: DirEntry[] = [];

  for (const name of names) {
    if (!showHidden && name.startsWith(".")) continue;
    if (IGNORED_DIRS.has(name) && name !== ".env") continue;

    // turbopackIgnore: the browsed tree is runtime data under VPM_ROOTS, not
    // application source. Tracing it would drag the whole server into the build.
    const full = path.join(/* turbopackIgnore: true */ realDir, name);
    const entry: DirEntry = {
      name,
      type: "other",
      size: 0,
      mtimeMs: 0,
    };

    try {
      const st = fs.lstatSync(full);
      entry.size = st.isSymbolicLink() ? 0 : st.size;
      entry.mtimeMs = st.mtimeMs;

      if (st.isSymbolicLink()) {
        entry.type = "symlink";
        try {
          const target = fs.realpathSync.native(full);
          entry.escaping = realRoot ? !isInside(realRoot, target) : true;
        } catch {
          entry.broken = true;
        }
      } else if (st.isDirectory()) {
        entry.type = "dir";
      } else if (st.isFile()) {
        entry.type = "file";
      }
    } catch {
      continue; // vanished between readdir and lstat
    }

    entries.push(entry);
  }

  entries.sort((a, b) => {
    if ((a.type === "dir") !== (b.type === "dir")) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });

  return entries;
}

/** The allowed root that contains `p`, or null. */
export function enclosingRoot(p: string): string | null {
  for (const r of rootRealpaths()) {
    if (isInside(r, p)) return r;
  }
  return null;
}

/** Absolute path -> path relative to its root, for display. */
export function toDisplayPath(p: string): string {
  for (const r of rootRealpaths()) {
    if (isInside(r, p)) {
      const rel = path.relative(r, p);
      return rel === "" ? "/" : `/${rel.split(path.sep).join("/")}`;
    }
  }
  return p;
}
