import "server-only";
import { db } from "./db";
import { getProject } from "./projects";
import { resolveDir } from "./safe-path";
import { run } from "./exec";
import { startDeploy, getDeploy } from "./deploy";
import { lockProject, projectBusy } from "./project-lock";
import { audit } from "./audit";
import { dailyDatabaseBackup } from "./maintenance";

export interface Automation {
  path: string; enabled: number; interval_sec: number; checked_at: number | null;
  next_check_at: number; attempted_commit: string | null; deploy_id: string | null; error: string | null;
}

export function listAutomation(): Automation[] {
  return db().prepare("SELECT * FROM project_automation ORDER BY path").all() as unknown as Automation[];
}

export function configureAutomation(project: string, enabled: boolean, intervalSec: number, meta: { user: string; ip: string }): void {
  if (!Number.isInteger(intervalSec) || intervalSec < 60 || intervalSec > 86400) throw new Error("check interval must be 60–86400 seconds");
  const info = getProject(project);
  if (enabled && (!info.isGitRepo || !info.remote || !info.composeFile || !info.branch || info.branch === "HEAD")) throw new Error("automatic deployment requires an origin branch and a Compose file");
  db().prepare(`INSERT INTO project_automation (path, enabled, interval_sec) VALUES (?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET enabled=excluded.enabled, interval_sec=excluded.interval_sec, next_check_at=0, error=NULL`).run(info.absPath, enabled ? 1 : 0, intervalSec);
  audit({ ...meta, action: "automation.configure", target: info.absPath, detail: { enabled, intervalSec } });
}

const runtime = globalThis as typeof globalThis & { __vpmAutomation?: { timer?: ReturnType<typeof setInterval>; busy: boolean } };
const shared = runtime.__vpmAutomation ??= { busy: false };

/** Called by instrumentation, so polling continues with no open browser. */
export function startAutomationWorker(): void {
  if (shared.timer || process.env.NEXT_PHASE === "phase-production-build") return;
  shared.timer = setInterval(() => {
    try { dailyDatabaseBackup(); } catch (error) { console.error("Database backup:", error instanceof Error ? error.message : "failed"); }
    void automationTick().catch((error: unknown) => console.error("Automation worker:", error instanceof Error ? error.message : "check failed"));
  }, 15_000);
  shared.timer.unref();
}

export async function automationTick(now = Date.now()): Promise<void> {
  if (shared.busy || process.env.VPM_AUTOMATION === "0") return;
  shared.busy = true;
  try {
    for (const rule of listAutomation().filter((rule) => rule.enabled && rule.next_check_at <= now)) {
      if (projectBusy(rule.path)) continue;
      const previous = rule.deploy_id ? getDeploy(rule.deploy_id) : undefined;
      if (previous && ["queued", "running"].includes(previous.status)) continue;
      db().prepare("UPDATE project_automation SET checked_at=?, next_check_at=? WHERE path=?").run(now, now + rule.interval_sec * 1000, rule.path);
      let release: (() => void) | undefined;
      try {
        const cwd = resolveDir(rule.path);
        release = lockProject(cwd, "checking Git updates");
        let info = getProject(cwd);
        if (info.dirty) throw new Error("Skipped: uncommitted changes. Commit or remove server edits before enabling automatic updates.");
        if (!info.isGitRepo || !info.remote || !info.branch || !info.composeFile || info.branch === "HEAD") throw new Error("Skipped: project requires origin, a branch and Compose");
        const result = await run("git", ["fetch", "--prune", "origin"], { cwd, timeoutMs: 120_000 });
        if (result.code !== 0) throw new Error("Git fetch failed; check server repository credentials");
        info = getProject(cwd);
        if (info.dirty) throw new Error("Skipped: project files changed during check");
        if (info.ahead === null || info.behind === null || info.ahead > 0) throw new Error("Skipped: origin branch unavailable or local commits require manual deployment");
        const remote = await run("git", ["rev-parse", "--verify", `refs/remotes/origin/${info.branch}`], { cwd, timeoutMs: 10_000 });
        if (remote.code !== 0) throw new Error("Origin branch unavailable");
        if (info.behind === 0) {
          db().prepare("UPDATE project_automation SET error=NULL WHERE path=?").run(cwd);
          continue;
        }
        if (rule.attempted_commit === remote.stdout) {
          db().prepare("UPDATE project_automation SET error=? WHERE path=?").run("This commit was already attempted. Review deployment history and deploy manually, or push a new commit.", cwd);
          continue;
        }
        // Honour a pause saved while fetch was in progress.
        const current = db().prepare("SELECT enabled FROM project_automation WHERE path=?").get(cwd) as { enabled: number } | undefined;
        if (!current?.enabled) continue;
        release(); release = undefined;
        const handle = startDeploy(cwd, { usePull: true, requireClean: true, autoRollback: true, backupEnv: true, healthTimeoutSec: 60 }, { user: "automation", ip: "local" });
        db().prepare("UPDATE project_automation SET attempted_commit=?, deploy_id=?, error=NULL WHERE path=?").run(remote.stdout, handle.id, cwd);
        // Await completion to limit the worker to one unattended build at a time.
        const state = await handle.promise;
        db().prepare("UPDATE project_automation SET error=? WHERE path=?").run(state.status === "succeeded" ? null : `Deployment ${state.status}: ${state.error ?? "inspect deployment history"}`, cwd);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Automation check failed";
        db().prepare("UPDATE project_automation SET error=? WHERE path=?").run(message, rule.path);
        if (message !== rule.error) audit({ user: "automation", ip: "local", action: "automation.skipped", target: rule.path, ok: false, detail: { error: message } });
      } finally { release?.(); }
    }
  } finally { shared.busy = false; }
}
