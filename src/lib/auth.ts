import "server-only";
import crypto from "node:crypto";
import { cookies } from "next/headers";
import { db } from "./db";

/**
 * Auth: scrypt password hashing, mandatory TOTP, opaque server-side sessions.
 *
 * Deliberately dependency-free (node:crypto only) so the VPS needs no native
 * build toolchain. Sessions are random 256-bit ids stored hashed in SQLite —
 * a DB leak does not hand over live cookies.
 */

const SESSION_COOKIE = "vpm_session";
const SESSION_TTL_MS = Number(process.env.VPM_SESSION_TTL_MS ?? 12 * 60 * 60 * 1000);
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  password_salt: string;
  totp_secret: string | null;
  created_at: number;
  last_login_at: number | null;
}

function hashPassword(password: string, salt: Buffer): Buffer {
  return crypto.scryptSync(password, salt, 64, SCRYPT);
}

export function createUser(username: string, password: string): UserRow {
  const salt = crypto.randomBytes(16);
  const hash = hashPassword(password, salt);
  const info = db()
    .prepare(
      "INSERT INTO users (username, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(username, hash.toString("hex"), salt.toString("hex"), Date.now());
  return getUserById(Number(info.lastInsertRowid))!;
}

export function getUserById(id: number): UserRow | null {
  return (db().prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow) ?? null;
}

export function getUserByName(username: string): UserRow | null {
  return (
    (db()
      .prepare("SELECT * FROM users WHERE username = ?")
      .get(username) as UserRow) ?? null
  );
}

export function countUsers(): number {
  const row = db().prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
  return row.n;
}

/**
 * Constant-time password check. When the user does not exist we still burn a
 * comparable scrypt so response timing does not reveal valid usernames.
 */
export function verifyPassword(user: UserRow | null, password: string): boolean {
  if (!user) {
    crypto.scryptSync(password, crypto.randomBytes(16), 64, SCRYPT);
    return false;
  }
  const salt = Buffer.from(user.password_salt, "hex");
  const expected = Buffer.from(user.password_hash, "hex");
  const actual = hashPassword(password, salt);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function setPassword(userId: number, password: string): void {
  const salt = crypto.randomBytes(16);
  const hash = hashPassword(password, salt);
  db()
    .prepare("UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?")
    .run(hash.toString("hex"), salt.toString("hex"), userId);
}

export function setTotpSecret(userId: number, secret: string | null): void {
  db().prepare("UPDATE users SET totp_secret = ? WHERE id = ?").run(secret, userId);
}

function sessionHash(id: string): string {
  return crypto.createHash("sha256").update(id).digest("hex");
}

export function createSession(
  userId: number,
  meta: { ip?: string; userAgent?: string } = {},
): { token: string; expiresAt: number } {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  db()
    .prepare(
      `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(sessionHash(token), userId, now, expiresAt, now, meta.ip ?? null, meta.userAgent ?? null);
  db().prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now, userId);
  return { token, expiresAt };
}

export interface SessionUser {
  id: number;
  username: string;
  hasTotp: boolean;
}

export function validateSessionToken(token: string | undefined): SessionUser | null {
  if (!token) return null;
  const now = Date.now();

  const row = db()
    .prepare(
      `SELECT s.id AS sid, s.expires_at, u.id, u.username, u.totp_secret
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`,
    )
    .get(sessionHash(token)) as
    | { sid: string; expires_at: number; id: number; username: string; totp_secret: string | null }
    | undefined;

  if (!row) return null;
  if (row.expires_at < now) {
    db().prepare("DELETE FROM sessions WHERE id = ?").run(row.sid);
    return null;
  }

  // Sliding window: extend at most once a minute to avoid a write per request.
  if (now - (row.expires_at - SESSION_TTL_MS) > SESSION_TTL_MS - 60_000) {
    db()
      .prepare("UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE id = ?")
      .run(now + SESSION_TTL_MS, now, row.sid);
  }

  return { id: row.id, username: row.username, hasTotp: !!row.totp_secret };
}

export function destroySession(token: string | undefined): void {
  if (!token) return;
  db().prepare("DELETE FROM sessions WHERE id = ?").run(sessionHash(token));
}

export function destroyAllSessions(userId: number): void {
  db().prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

export function purgeExpiredSessions(): void {
  db().prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
}

export function sessionCookieName(): string {
  return SESSION_COOKIE;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  return validateSessionToken(store.get(SESSION_COOKIE)?.value);
}

export function buildSessionCookie(token: string, expiresAt: number): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    secure,
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ].join("; ");
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}
