import "server-only";
import { db } from "./db";

export interface AuditEntry {
  user?: string | null;
  action: string;
  target?: string | null;
  detail?: unknown;
  ip?: string | null;
  ok?: boolean;
}

/** Append-only record of anything that changes the machine. */
export function audit(entry: AuditEntry): void {
  try {
    db()
      .prepare(
        "INSERT INTO audit (ts, user, action, target, detail, ip, ok) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        Date.now(),
        entry.user ?? null,
        entry.action,
        entry.target ?? null,
        entry.detail === undefined ? null : safeStringify(entry.detail),
        entry.ip ?? null,
        entry.ok === false ? 0 : 1,
      );
  } catch {
    // Auditing must never break the operation it is recording.
  }
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === "object" && v !== null) {
      if (seen.has(v as object)) return "[circular]";
      seen.add(v as object);
    }
    if (typeof v === "string" && v.length > 2000) return v.slice(0, 2000) + "...[truncated]";
    return v;
  });
}

export interface AuditRow {
  id: number;
  ts: number;
  user: string | null;
  action: string;
  target: string | null;
  detail: string | null;
  ip: string | null;
  ok: number;
}

export function recentAudit(limit = 100): AuditRow[] {
  return db()
    .prepare("SELECT * FROM audit ORDER BY ts DESC LIMIT ?")
    .all(Math.min(limit, 500)) as AuditRow[];
}
