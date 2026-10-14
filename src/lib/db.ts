import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { DATA_DIR, DB_PATH } from "./config";

/**
 * node:sqlite (built into Node 22+) instead of better-sqlite3: no native
 * compilation, no build toolchain on the server, one less thing to patch.
 */

let _db: DatabaseSync | null = null;
const runtime = globalThis as typeof globalThis & { __vpmDatabase?: { path: string; database: DatabaseSync } };

export function db(): DatabaseSync {
  if (_db) return _db;
  if (runtime.__vpmDatabase?.path === DB_PATH) return _db = runtime.__vpmDatabase.database;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const database = new DatabaseSync(DB_PATH);

  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");

  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      totp_secret   TEXT,
      created_at    INTEGER NOT NULL,
      last_login_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id           TEXT PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at   INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      ip           TEXT,
      user_agent   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS login_challenges (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      ts       INTEGER NOT NULL,
      user     TEXT,
      action   TEXT NOT NULL,
      target   TEXT,
      detail   TEXT,
      ip       TEXT,
      ok       INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts DESC);

    CREATE TABLE IF NOT EXISTS deploys (
      id          TEXT PRIMARY KEY,
      project     TEXT NOT NULL,
      branch      TEXT,
      status      TEXT NOT NULL,
      started_at  INTEGER NOT NULL,
      finished_at INTEGER,
      commit_before TEXT,
      commit_after  TEXT,
      log         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_deploys_started ON deploys(started_at DESC);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS file_shares (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      file_version TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER,
      max_downloads INTEGER,
      downloads INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_file_shares_path ON file_shares(user_id, file_path);
  `);

  const deployColumns = database.prepare("PRAGMA table_info(deploys)").all() as { name: string }[];
  if (!deployColumns.some((column) => column.name === "error")) database.exec("ALTER TABLE deploys ADD COLUMN error TEXT");
  if (!deployColumns.some((column) => column.name === "abs_path")) database.exec("ALTER TABLE deploys ADD COLUMN abs_path TEXT");
  // This single-process service cannot resume work interrupted by a restart.
  database.prepare("UPDATE deploys SET status = 'failed', finished_at = ?, error = 'service restarted during deploy' WHERE status IN ('queued', 'running')").run(Date.now());

  _db = database;
  runtime.__vpmDatabase = { path: DB_PATH, database };
  return database;
}

export function getSetting(key: string): string | null {
  const row = db().prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db()
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

export function closeDb(): void {
  _db?.close();
  _db = null;
  delete runtime.__vpmDatabase;
}
