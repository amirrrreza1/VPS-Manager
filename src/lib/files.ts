import "server-only";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  resolveFile,
  resolveDir,
  resolveForWrite,
  resolveSafe,
  listDir,
  PathError,
  toDisplayPath,
} from "./safe-path";
import { MAX_EDIT_BYTES, MAX_UPLOAD_BYTES, SECRET_FILE_PATTERNS, EDITABLE_EXTENSIONS } from "./config";
import { audit } from "./audit";
import { fileRoots, personalFilesRoot } from "./roots";
import { inspectMedia } from "./media";

/**
 * File read/write. All operations resolve through safe-path.ts first, so the
 * caller can never escape the allowed roots.
 *
 * Writes are atomic (temp file + rename) and create a timestamped .bak sibling
 * so a bad edit is always recoverable from the UI.
 */

export function isSecretFile(name: string): boolean {
  const base = path.basename(name).replace(/\.\d+(?:-[a-f0-9]+)?\.bak$/i, "");
  return SECRET_FILE_PATTERNS.some((re) => re.test(base));
}

export function isEditable(name: string): boolean {
  if (isSecretFile(name)) return true;
  const ext = path.extname(name).toLowerCase();
  if (EDITABLE_EXTENSIONS.has(ext)) return true;
  // Extensionless files that are conventionally config/text
  return ["Dockerfile", "Makefile", "Procfile", "LICENSE", "README", "Caddyfile", "nginx.conf"].includes(
    path.basename(name),
  );
}

export interface FileContent {
  path: string;
  name: string;
  content: string;
  size: number;
  mtimeMs: number;
  /** True when values are masked in the returned content. */
  redacted: boolean;
  binary: boolean;
}

function isBinaryBuffer(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Mask values of secret-looking keys so a shoulder-surfer or a screen share
 * does not leak credentials. Writing requires an explicit "reveal" round-trip
 * which overwrites the masked values server-side with what the client sends.
 */
export function redactContent(text: string): { text: string; redacted: boolean } {
  const lines = text.split("\n");
  let redacted = false;
  const out = lines.map((line) => {
    const m = line.match(/^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*)(.*)$/);
    if (!m) return line;
    const key = m[1];
    const value = m[2];
    if (value === "" || value.startsWith("#")) return line;
    // Only mask plausible secret values.
    if (value.length < 8 && !/password|secret|token|key/i.test(key)) return line;
    if (/^(https?:\/\/localhost|127\.0\.0\.1)/.test(value) && !/password|secret|token|key/i.test(key)) {
      return line;
    }
    redacted = true;
    return `${key}${"*".repeat(Math.min(value.length, 24))}`;
  });
  return { text: out.join("\n"), redacted };
}

export function readFileSafe(filePath: string, opts: { reveal?: boolean } = {}): FileContent {
  const abs = resolveFile(filePath);
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new PathError("not a file", 400);
  if (st.size > MAX_EDIT_BYTES) {
    throw new PathError(
      `file is ${formatBytes(st.size)} - too large to edit (limit ${formatBytes(MAX_EDIT_BYTES)})`,
      413,
    );
  }

  const buf = fs.readFileSync(abs);
  const name = path.basename(abs);
  const binary = isBinaryBuffer(buf);

  let content = binary ? "" : buf.toString("utf8");
  let redacted = false;
  if (!opts.reveal && isSecretFile(name)) {
    const envLike = /(?:^\.env(?:\..+)?$|\.env$)/i.test(name.replace(/\.\d+(?:-[a-f0-9]+)?\.bak$/i, ""));
    const r = envLike ? redactContent(content) : { text: "[Secret file hidden — reveal values to view or edit]", redacted: true };
    content = r.text;
    redacted = r.redacted;
  }

  return {
    path: toDisplayPath(abs),
    name,
    content,
    size: st.size,
    mtimeMs: st.mtimeMs,
    redacted,
    binary,
  };
}

export function readFileRaw(filePath: string): { name: string; content: Buffer; mtimeMs: number } {
  const abs = resolveFile(filePath);
  const st = fs.statSync(abs);
  if (st.size > MAX_UPLOAD_BYTES) throw new PathError("file too large to download", 413);
  return { name: path.basename(abs), content: fs.readFileSync(abs), mtimeMs: st.mtimeMs };
}

export interface WriteResult {
  path: string;
  bytes: number;
  backupPath: string | null;
  mtimeMs: number;
}

/**
 * Refuse to write a file whose values are still masked.
 *
 * The editor masks secret values for display. Writing that masked text back
 * would replace real credentials with asterisks and break the very app the
 * file configures - silent data loss. The client disables Save, but the API
 * must not depend on the client behaving.
 */
function assertNotMasked(absPath: string, content: string): void {
  if (!isSecretFile(absPath)) return;
  const masked = content
    .split("\n")
    .some((line) => /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*\*{4,}/.test(line));
  if (masked || content.includes("[Secret file hidden — reveal values to view or edit]")) {
    throw new PathError(
      "refusing to write masked secret values - open the file with reveal enabled first",
      400,
    );
  }
}

export function writeFileSafe(
  filePath: string,
  content: string,
  meta: { user: string; ip: string },
  expectedMtimeMs?: number,
): WriteResult {
  const abs = resolveForWrite(filePath);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    throw new PathError("path is a directory", 400);
  }

  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_EDIT_BYTES) {
    throw new PathError(`content is ${formatBytes(bytes)} - exceeds edit limit`, 413);
  }
  assertNotMasked(abs, content);
  if (expectedMtimeMs !== undefined && (!fs.existsSync(abs) || fs.statSync(abs).mtimeMs !== expectedMtimeMs)) {
    throw new PathError("file changed on disk; reopen it before saving", 409);
  }

  let backupPath: string | null = null;
  if (fs.existsSync(abs)) {
    const st = fs.statSync(abs);
    const bak = `${abs}.${Date.now()}-${crypto.randomBytes(3).toString("hex")}.bak`;
    fs.copyFileSync(abs, bak);
    backupPath = toDisplayPath(bak);
    fs.chmodSync(bak, st.mode);
  }

  // Atomic write.
  const tmp = `${abs}.tmp-${crypto.randomBytes(6).toString("hex")}`;
  fs.writeFileSync(tmp, content, { encoding: "utf8", mode: fs.existsSync(abs) ? fs.statSync(abs).mode : 0o600 });
  try {
    fs.renameSync(tmp, abs);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch { /* ignore */ }
    throw err;
  }

  audit({
    user: meta.user,
    ip: meta.ip,
    action: "file.write",
    target: toDisplayPath(abs),
    detail: { bytes, backup: backupPath },
  });

  return { path: toDisplayPath(abs), bytes, backupPath, mtimeMs: fs.statSync(abs).mtimeMs };
}

export function createFile(
  dirPath: string,
  name: string,
  content: string,
  meta: { user: string; ip: string },
): WriteResult {
  assertSafeName(name);
  const dir = resolveDir(dirPath);
  const target = path.join(dir, name);
  if (fs.existsSync(target)) throw new PathError("already exists", 409);
  return writeFileSafe(target, content, meta);
}

export function createDirectory(
  dirPath: string,
  name: string,
  meta: { user: string; ip: string },
): { path: string } {
  assertSafeName(name);
  const dir = resolveDir(dirPath);
  const target = path.join(dir, name);
  if (fs.existsSync(target)) throw new PathError("already exists", 409);
  fs.mkdirSync(target);
  audit({ user: meta.user, ip: meta.ip, action: "fs.mkdir", target: toDisplayPath(target) });
  return { path: toDisplayPath(target) };
}

export function renameEntry(
  oldPath: string,
  newName: string,
  meta: { user: string; ip: string },
): { path: string } {
  assertSafeName(newName);
  const from = resolveSafe(oldPath, undefined, { mustExist: true });
  assertMutableEntry(oldPath, from);
  const parent = resolveDir(path.dirname(from));
  const to = path.join(parent, newName);
  if (from === to) return { path: toDisplayPath(from) };
  // On case-insensitive filesystems the new spelling resolves to the source.
  const caseOnlyRename = path.basename(from).toLowerCase() === newName.toLowerCase()
    && fs.existsSync(to) && fs.realpathSync.native(from) === fs.realpathSync.native(to);
  if (fs.existsSync(to) && !caseOnlyRename) throw new PathError("a file with that name already exists", 409);
  fs.renameSync(from, to);
  audit({
    user: meta.user,
    ip: meta.ip,
    action: "fs.rename",
    target: toDisplayPath(to),
    detail: { from: toDisplayPath(from) },
  });
  return { path: toDisplayPath(to) };
}

export function deleteEntry(
  targetPath: string,
  meta: { user: string; ip: string },
): { path: string } {
  const abs = resolveSafe(targetPath, undefined, { mustExist: true });
  const root = path.parse(abs).root;
  if (abs === root) throw new PathError("refusing to delete a filesystem root", 400);
  assertMutableEntry(targetPath, abs);
  const st = fs.lstatSync(abs);
  fs.rmSync(abs, { recursive: st.isDirectory(), force: false });
  audit({
    user: meta.user,
    ip: meta.ip,
    action: "fs.delete",
    target: toDisplayPath(abs),
    detail: { type: st.isDirectory() ? "dir" : "file" },
  });
  return { path: toDisplayPath(abs) };
}

function assertMutableEntry(input: string, resolved: string): void {
  for (const root of fileRoots()) {
    let realRoot: string;
    try { realRoot = fs.realpathSync.native(root); } catch { continue; }
    const relative = path.relative(resolved, realRoot);
    if (relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))) {
      throw new PathError("refusing to mutate a configured root or its parent", 400);
    }
  }
  // Resolve the parent separately so these operations never delete a link's target.
  const parent = resolveDir(path.dirname(input));
  const lexical = path.join(parent, path.basename(input));
  if (fs.lstatSync(lexical).isSymbolicLink()) throw new PathError("renaming or deleting symlinks is not supported", 400);
}

export function uploadFile(
  dirPath: string,
  name: string,
  data: Buffer,
  meta: { user: string; ip: string },
): WriteResult {
  assertSafeName(name);
  if (data.length > MAX_UPLOAD_BYTES) throw new PathError("upload too large", 413);
  const dir = resolveDir(dirPath);
  const target = path.join(dir, name);
  if (fs.existsSync(target)) throw new PathError("already exists", 409);
  fs.writeFileSync(target, data, { flag: "wx", mode: 0o600 });
  audit({
    user: meta.user,
    ip: meta.ip,
    action: "file.upload",
    target: toDisplayPath(target),
    detail: { bytes: data.length },
  });
  return { path: toDisplayPath(target), bytes: data.length, backupPath: null, mtimeMs: fs.statSync(target).mtimeMs };
}

export function listDirectory(dirPath: string) {
  const abs = resolveDir(dirPath);
  return {
    path: toDisplayPath(abs),
    parent: (() => {
      try { if (abs === fs.realpathSync.native(personalFilesRoot())) return null; } catch { /* not created yet */ }
      const p = path.dirname(abs);
      try {
        resolveDir(p);
        return toDisplayPath(p);
      } catch {
        return null;
      }
    })(),
    entries: listDir(abs),
  };
}

/** Recursive filename/content search within the roots. */
export function searchFiles(
  query: string,
  opts: { limit?: number; content?: boolean; dir?: string } = {},
): { path: string; name: string; matches: { line: number; text: string }[] }[] {
  const q = query.trim();
  if (q.length < 2) return [];
  const limit = Math.min(opts.limit ?? 50, 200);
  const results: { path: string; name: string; matches: { line: number; text: string }[] }[] = [];

  const startDirs = opts.dir ? [resolveDir(opts.dir)] : [];
  const needle = q.toLowerCase();

  const walk = (dir: string, depth: number) => {
    if (depth > 12 || results.length >= limit) return;
    let entries: ReturnType<typeof listDir>;
    try {
      entries = listDir(dir, { showHidden: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= limit) return;
      const full = path.join(dir, e.name);
      if (e.type === "dir") {
        walk(full, depth + 1);
        continue;
      }
      if (e.type === "symlink" && e.escaping) continue;

      const nameHit = e.name.toLowerCase().includes(needle);
      const lineMatches: { line: number; text: string }[] = [];

      if (opts.content && isEditable(e.name) && !isSecretFile(e.name)) {
        try {
          const st = fs.statSync(full);
          if (st.size > 512 * 1024) continue;
          const text = fs.readFileSync(full, "utf8");
          if (text.includes("\0")) continue;
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length && lineMatches.length < 5; i++) {
            if (lines[i].toLowerCase().includes(needle)) {
              lineMatches.push({ line: i + 1, text: lines[i].slice(0, 300) });
            }
          }
        } catch {
          continue;
        }
      }

      if (nameHit || lineMatches.length > 0) {
        results.push({ path: toDisplayPath(full), name: e.name, matches: lineMatches });
      }
    }
  };

  if (startDirs.length > 0) {
    for (const d of startDirs) walk(d, 0);
  } else {
    for (const r of fileRoots()) {
      try {
        walk(resolveDir(r), 0);
      } catch {
        continue;
      }
    }
  }

  return results;
}

export function assertSafeName(name: string): void {
  if (typeof name !== "string" || name.length === 0 || name.length > 255) {
    throw new PathError("invalid name");
  }
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new PathError("name may not contain path separators");
  }
  if (name === "." || name === "..") throw new PathError("invalid name");
  if (/[<>:"|?*]/.test(name)) throw new PathError("name contains illegal characters");
  if (/[\x00-\x1f\x7f]/.test(name) || name.startsWith(".vpm-upload-")) throw new PathError("invalid name");
}

export function ensurePersonalStorage(): void {
  fs.mkdirSync(personalFilesRoot(), { recursive: true, mode: 0o700 });
}

export function fileInfo(filePath: string) {
  const abs = resolveFile(filePath);
  const stat = fs.statSync(abs);
  if (!stat.isFile()) throw new PathError("not a regular file", 400);
  const name = path.basename(abs);
  return {
    path: toDisplayPath(abs), name, size: stat.size, mtimeMs: stat.mtimeMs,
    editable: isEditable(name), previewAvailable: isEditable(name) && stat.size <= MAX_EDIT_BYTES,
    mediaPreview: isSecretFile(name) ? null : inspectMedia(abs),
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
