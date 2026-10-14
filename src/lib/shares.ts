import "server-only";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { db } from "./db";
import { audit } from "./audit";
import { isSecretFile } from "./files";
import { personalFilesRoot } from "./roots";
import { resolveFile, PathError, toDisplayPath } from "./safe-path";
import { openDownload } from "./transfers";

const MAX_LIFETIME = 7 * 24 * 60 * 60 * 1000;
type Owner = { id: number; username: string };
interface ShareRow {
  id: string; file_path: string; file_version: string; expires_at: number;
  revoked_at: number | null; max_downloads: number | null; downloads: number;
}

function hashToken(token: string) { return crypto.createHash("sha256").update(token).digest("hex"); }

function personalFile(input: string): string {
  const abs = resolveFile(input);
  const root = fs.realpathSync.native(personalFilesRoot());
  const relative = path.relative(root, abs);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new PathError("Only files in Personal files can be shared", 403);
  }
  if (isSecretFile(abs)) throw new PathError("Secret and credential files cannot be shared", 403);
  return abs;
}

export function createShare(input: string, lifetimeMs: number, oneTime: boolean, owner: Owner, ip: string) {
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 60_000 || lifetimeMs > MAX_LIFETIME) {
    throw new PathError("Link expiry must be between 1 minute and 7 days");
  }
  const abs = personalFile(input);
  const file = openDownload(abs);
  fs.closeSync(file.fd);
  const token = crypto.randomBytes(32).toString("base64url");
  const id = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + lifetimeMs;
  db().prepare(`INSERT INTO file_shares
    (id, token_hash, user_id, file_path, file_version, created_at, expires_at, max_downloads)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, hashToken(token), owner.id, abs, JSON.stringify(file.version), now, expiresAt, oneTime ? 1 : null);
  // Never persist the bearer token in the audit log or return it in listings.
  audit({ user: owner.username, ip, action: "share.create", target: toDisplayPath(abs), detail: { id, expiresAt, oneTime } });
  return { id, expiresAt, oneTime, downloadPath: `/api/shared/${token}/download` };
}

export function listShares(input: string | null, owner: Owner) {
  const abs = input === null ? null : resolveFile(input);
  const rows = db().prepare(`SELECT id, file_path, created_at, expires_at, revoked_at, max_downloads, downloads
    FROM file_shares WHERE user_id = ? AND (? IS NULL OR file_path = ?) ORDER BY created_at DESC LIMIT 100`)
    .all(owner.id, abs, abs) as (ShareRow & { created_at: number })[];
  return rows.map((row) => ({ id: row.id, path: toDisplayPath(row.file_path), name: path.basename(row.file_path),
    createdAt: row.created_at, expiresAt: row.expires_at, downloads: row.downloads, oneTime: row.max_downloads === 1,
    active: !row.revoked_at && row.expires_at > Date.now() && (row.max_downloads === null || row.downloads < row.max_downloads),
  }));
}

export function revokeShare(id: string, owner: Owner, ip: string) {
  const result = db().prepare("UPDATE file_shares SET revoked_at = ? WHERE id = ? AND user_id = ?").run(Date.now(), id, owner.id);
  if (!result.changes) throw new PathError("Link not found", 404);
  audit({ user: owner.username, ip, action: "share.revoke", target: id });
}

export function claimShare(token: string, ip: string) {
  const unavailable = () => new PathError("This download link is unavailable or expired", 404);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw unavailable();
  const row = db().prepare("SELECT * FROM file_shares WHERE token_hash = ?").get(hashToken(token)) as ShareRow | undefined;
  if (!row || row.revoked_at || row.expires_at <= Date.now() || (row.max_downloads !== null && row.downloads >= row.max_downloads)) throw unavailable();
  let file: ReturnType<typeof openDownload>;
  try { file = openDownload(personalFile(row.file_path)); } catch { throw unavailable(); }
  try {
    // A link cannot silently expose a replacement or newly edited file.
    if (JSON.stringify(file.version) !== row.file_version) throw unavailable();
    const result = db().prepare(`UPDATE file_shares SET downloads = downloads + 1
      WHERE id = ? AND revoked_at IS NULL AND expires_at > ? AND (max_downloads IS NULL OR downloads < max_downloads)`)
      .run(row.id, Date.now());
    if (!result.changes) throw unavailable();
    audit({ action: "share.download", target: row.id, ip });
    return file;
  } catch (error) { fs.closeSync(file.fd); throw error; }
}
