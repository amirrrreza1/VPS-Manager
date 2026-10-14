import "server-only";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import { run, CommandError } from "./exec";
import { resolveDir, resolveFile, resolveForWrite } from "./safe-path";
import { db } from "./db";
import { getProject } from "./projects";
import { audit } from "./audit";

/**
 * Deploy pipeline.
 *
 * Default sequence (matching the requested flow):
 *   1. backup .env files        (so a bad deploy can be undone)
 *   2. docker compose down
 *   3. git fetch --all --prune
 *   4. git reset --hard origin/<branch>   (or git pull --ff-only)
 *   5. docker compose up -d --build
 *   6. health check
 *
 * If a health check is configured and the new container is not healthy, we
 * automatically roll back: restore the previous commit, restore the .env
 * backup, and bring the stack back up on the old image.
 */

export type DeployStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "rolled_back"
  | "aborted";

export interface DeployStep {
  n: number;
  label: string;
  status: "pending" | "running" | "ok" | "failed" | "skipped";
  output: string;
  durationMs: number;
}

export interface DeployState {
  id: string;
  project: string;
  absPath: string;
  branch: string | null;
  status: DeployStatus;
  steps: DeployStep[];
  startedAt: number;
  finishedAt: number | null;
  commitBefore: string | null;
  commitAfter: string | null;
  error: string | null;
}

const runtime = globalThis as typeof globalThis & { __vpmDeployRuntime?: {
  events: EventEmitter; inflight: Map<string, DeployState>; handles: Map<string, DeployHandle>;
} };
const shared = runtime.__vpmDeployRuntime ??= {
  events: new EventEmitter(), inflight: new Map(), handles: new Map(),
};
export const deployEvents = shared.events;
deployEvents.setMaxListeners(50);
const inflight = shared.inflight;
const handles = shared.handles;
const MAX_LOG = 512 * 1024;

export function getDeploy(id: string): DeployState | undefined {
  const live = inflight.get(id);
  if (live) return live;
  const row = db().prepare("SELECT * FROM deploys WHERE id = ?").get(id) as DeployHistoryRow | undefined;
  if (!row) return undefined;
  let steps: DeployStep[] = [];
  try { steps = row.log ? JSON.parse(row.log) : []; } catch { /* tolerate old truncated logs */ }
  return { id: row.id, project: row.project, absPath: row.abs_path ?? "", branch: row.branch,
    status: row.status as DeployStatus, steps, startedAt: row.started_at, finishedAt: row.finished_at,
    commitBefore: row.commit_before, commitAfter: row.commit_after, error: row.error ?? null };
}

/** Request a cooperative abort of a running deploy. */
export function abortDeploy(id: string): boolean {
  const handle = handles.get(id);
  if (!handle || !["queued", "running"].includes(inflight.get(id)?.status ?? "")) return false;
  handle.abort();
  return true;
}

export function listActiveDeploys(): DeployState[] {
  return [...inflight.values()].filter(
    (d) => d.status === "running" || d.status === "queued",
  );
}

export interface DeployOptions {
  /** Skip `git reset --hard` and use `git pull --ff-only` (safer with unpushed work). */
  usePull?: boolean;
  branch?: string;
  /** --no-build skips image rebuild. */
  build?: boolean;
  /** Seconds to wait for the container to become healthy. 0 disables. */
  healthTimeoutSec?: number;
  /** Roll back automatically when the health check fails. */
  autoRollback?: boolean;
  /** Back up and restore .env files around the deploy. */
  backupEnv?: boolean;
}

function emit(state: DeployState): void {
  deployEvents.emit("update", state);
  deployEvents.emit(`update:${state.id}`, state);
}

function appendOutput(state: DeployState, step: DeployStep, text: string): void {
  step.output = (step.output + text).slice(-MAX_LOG);
  emit(state);
}

function finishStep(state: DeployState, step: DeployStep, code: number): void {
  step.durationMs = Date.now() - stepStarted.get(step)!;
  if (code === 0) {
    step.status = "ok";
  } else {
    step.status = "failed";
    step.output = step.output.trim().slice(-8000);
  }
  emit(state);
  persist(state);
}

const stepStarted = new WeakMap<DeployStep, number>();

export interface DeployHandle {
  id: string;
  promise: Promise<DeployState>;
  abort: () => void;
}

export function startDeploy(
  projectPath: string,
  opts: DeployOptions = {},
  meta: { user: string; ip: string } = { user: "system", ip: "unknown" },
): DeployHandle {
  const absPath = resolveDir(projectPath);
  if (listActiveDeploys().some((state) => state.absPath === absPath)) throw new Error("a deploy is already running for this project");
  const info = getProject(absPath);
  if (!info.composeFile) throw new Error("project has no compose file");
  resolveFile(path.join(absPath, info.composeFile));
  const branch = opts.branch ?? info.branch;
  if (info.isGitRepo && (!branch || branch === "HEAD" || branch.startsWith("-") || !/^[A-Za-z0-9._/\-]+$/.test(branch))) {
    throw new Error("select a valid origin branch before deploying");
  }
  const id = crypto.randomUUID();
  let aborted = false;

  const state: DeployState = {
    id,
    project: path.basename(absPath),
    absPath,
    branch: opts.branch ?? null,
    status: "queued",
    steps: [],
    startedAt: Date.now(),
    finishedAt: null,
    commitBefore: null,
    commitAfter: null,
    error: null,
  };
  inflight.set(id, state);

  const promise = (async (): Promise<DeployState> => {
    state.status = "running";
    emit(state);

    state.branch = opts.branch ?? info.branch;
    state.commitBefore = info.commit;

    db()
      .prepare(
        `INSERT INTO deploys (id, project, branch, status, started_at, commit_before, abs_path)
         VALUES (?, ?, ?, 'running', ?, ?, ?)`,
      )
      .run(id, state.project, state.branch, state.startedAt, info.commit, absPath);

    audit({
      user: meta.user,
      action: "deploy.start",
      target: state.project,
      ip: meta.ip,
      detail: { branch: state.branch, build: opts.build !== false, mode: opts.usePull ? "pull" : "reset" },
    });

    const envBackups: { file: string; content: Buffer }[] = [];
    let success = false;
    let stackTouched = false;
    // Declared outside the try so the rollback path can use it too.
    const compose = info.composeFile ?? "docker-compose.yml";

    try {
      // ---- 1. backup env -------------------------------------------------
      if (opts.backupEnv !== false) {
        const s = addStep(state, "Back up environment files");
        stepStarted.set(s, Date.now());
        for (const name of [".env", ".env.production", ".env.local"]) {
          const p = path.join(/* turbopackIgnore: true */ absPath, name);
          if (fs.existsSync(/* turbopackIgnore: true */ p)) {
            envBackups.push({ file: resolveFile(p), content: fs.readFileSync(resolveFile(p)) });
          }
        }
        appendOutput(
          state,
          s,
          envBackups.length
            ? `backed up ${envBackups.length} file(s): ${envBackups
                .map((b) => path.basename(b.file))
                .join(", ")}`
            : "no .env files found",
        );
        finishStep(state, s, 0);
      }

      // ---- 2. docker compose down ---------------------------------------
      checkAborted(aborted);
      stackTouched = true;
      const down = addStep(state, `docker compose down (${compose})`);
      stepStarted.set(down, Date.now());
      const downRes = await run(
        "docker",
        ["compose", "-f", compose, "down"],
        { cwd: absPath, timeoutMs: 180_000, onOutput: (c) => appendOutput(state, down, c) },
      );
      finishStep(state, down, downRes.code);
      if (downRes.code !== 0) throw new Error(`docker compose down failed: ${downRes.stderr}`);

      // ---- 3. git fetch ---------------------------------------------------
      const gitAvailable = info.isGitRepo;
      if (gitAvailable) {
        checkAborted(aborted);
        const fetch = addStep(state, "git fetch --all --prune");
        stepStarted.set(fetch, Date.now());
        const fetchRes = await run("git", ["fetch", "--all", "--prune"], {
          cwd: absPath,
          timeoutMs: 120_000,
          onOutput: (c) => appendOutput(state, fetch, c),
        });
        finishStep(state, fetch, fetchRes.code);
        if (fetchRes.code !== 0) throw new Error(`git fetch failed: ${fetchRes.stderr}`);

        // ---- 4. update working tree --------------------------------------
        checkAborted(aborted);
        const branch = state.branch;
        const target = branch ? `origin/${branch}` : null;
        const update = addStep(
          state,
          opts.usePull
            ? `git pull --ff-only${branch ? ` (${branch})` : ""}`
            : target
              ? `git reset --hard ${target}`
              : "git reset --hard HEAD",
        );
        stepStarted.set(update, Date.now());

        const updateArgs = opts.usePull
          ? branch
            ? ["pull", "--ff-only", "origin", branch]
            : ["pull", "--ff-only"]
          : target
            ? ["reset", "--hard", target]
            : ["reset", "--hard", "HEAD"];

        const updateRes = await run("git", updateArgs, {
          cwd: absPath,
          timeoutMs: 120_000,
          onOutput: (c) => appendOutput(state, update, c),
        });
        finishStep(state, update, updateRes.code);
        if (updateRes.code !== 0) throw new Error(`git update failed: ${updateRes.stderr}`);

        const after = getProject(absPath);
        state.commitAfter = after.commit;
      } else {
        const skip = addStep(state, "git update (skipped - not a git repository)");
        stepStarted.set(skip, Date.now());
        appendOutput(state, skip, "no .git directory found; continuing with existing files");
        finishStep(state, skip, 0);
      }

      checkAborted(aborted);

      // ---- 5. docker compose up -----------------------------------------
      const upArgs = ["compose", "-f", compose, "up", "-d"];
      if (opts.build !== false) upArgs.push("--build");
      const up = addStep(state, `docker compose up -d${opts.build !== false ? " --build" : ""}`);
      stepStarted.set(up, Date.now());
      const upRes = await run("docker", upArgs, {
        cwd: absPath,
        timeoutMs: 20 * 60_000,
        onOutput: (c) => appendOutput(state, up, c),
      });
      finishStep(state, up, upRes.code);
      if (upRes.code !== 0) throw new Error(`docker compose up failed: ${upRes.stderr}`);
      checkAborted(aborted);

      // ---- 6. health ------------------------------------------------------
      const timeoutSec = opts.healthTimeoutSec ?? 0;
      if (timeoutSec > 0) {
        const health = addStep(state, `Health check (timeout ${timeoutSec}s)`);
        stepStarted.set(health, Date.now());
        const healthy = await waitForHealthy(absPath, compose, timeoutSec, () => aborted, (c) =>
          appendOutput(state, health, c),
        );
        checkAborted(aborted);
        if (healthy) {
          appendOutput(state, health, "all services running");
          finishStep(state, health, 0);
          success = true;
        } else {
          finishStep(state, health, 1);
          throw new Error("health check timed out - containers not running");
        }
      } else {
        success = true;
      }
    } catch (err) {
      const message = err instanceof CommandError ? err.message : (err as Error).message;
      state.error = message;
      for (const step of state.steps) if (step.status === "running") finishStep(state, step, 1);

      if (aborted) {
        if (opts.autoRollback && stackTouched) {
          const restore = addStep(state, "Restore previous version after abort");
          const restored = await rollback(state, restore, absPath, compose, envBackups, opts);
          finishStep(state, restore, restored ? 0 : 1);
          if (!restored) state.error += "; restoring the previous stack failed";
        }
        state.status = "aborted";
        state.finishedAt = Date.now();
        audit({ user: meta.user, action: "deploy.abort", target: state.project, ip: meta.ip, detail: { id } });
        emit(state);
        persist(state);
        return state;
      }

      if (opts.autoRollback && stackTouched) {
        const rb = addStep(state, "Roll back to previous version");
        stepStarted.set(rb, Date.now());
        const ok = await rollback(state, rb, absPath, compose, envBackups, opts);
        if (ok) {
          finishStep(state, rb, 0);
          state.status = "rolled_back";
          state.finishedAt = Date.now();
          audit({
            user: meta.user,
            action: "deploy.rolled_back",
            target: state.project,
            ip: meta.ip,
            ok: false,
            detail: { id, error: message },
          });
          emit(state);
          persist(state);
          return state;
        }
        finishStep(state, rb, 1);
      }

      state.status = "failed";
      state.finishedAt = Date.now();
      audit({
        user: meta.user,
        action: "deploy.failed",
        target: state.project,
        ip: meta.ip,
        ok: false,
        detail: { id, error: message },
      });
    }

    if (!state.finishedAt) state.finishedAt = Date.now();
    if (success) {
      state.status = "succeeded";
      audit({
        user: meta.user,
        action: "deploy.succeeded",
        target: state.project,
        ip: meta.ip,
        detail: { id, commit: state.commitAfter },
      });
    }
    emit(state);
    persist(state);
    return state;
  })().catch((error: unknown) => {
    state.status = "failed"; state.finishedAt = Date.now();
    state.error = error instanceof Error ? error.message : "deploy failed";
    emit(state); persist(state); return state;
  });

  const handle: DeployHandle = {
    id,
    promise,
    abort: () => {
      aborted = true;
    },
  };
  handles.set(id, handle);
  void promise.finally(() => {
    handles.delete(id);
    // Retain a bounded set of completed deployments for stream reconnects.
    const completed = [...inflight.values()].filter((d) => !["queued", "running"].includes(d.status));
    for (const old of completed.slice(0, Math.max(0, completed.length - 50))) inflight.delete(old.id);
  }).catch(() => undefined);

  return handle;
}

function addStep(state: DeployState, label: string): DeployStep {
  const step: DeployStep = {
    n: state.steps.length + 1,
    label,
    status: "running",
    output: "",
    durationMs: 0,
  };
  stepStarted.set(step, Date.now());
  state.steps.push(step);
  emit(state);
  return step;
}

function checkAborted(aborted: boolean): void {
  if (aborted) throw new Error("aborted by operator");
}

async function waitForHealthy(
  cwd: string,
  composeFile: string,
  timeoutSec: number,
  isAborted: () => boolean,
  onOutput: (c: string) => void,
): Promise<boolean> {
  const deadline = Date.now() + timeoutSec * 1000;
  let last = "";
  while (Date.now() < deadline) {
    if (isAborted()) return false;
    try {
      const res = await run("docker", ["compose", "-f", composeFile, "ps", "--all", "--format", "json"], {
        cwd,
        timeoutMs: 20_000,
      });
      if (res.code === 0) {
        last = res.stdout;
        const lines: string[] = res.stdout.trim().startsWith("[") ? JSON.parse(res.stdout).map((s: unknown) => JSON.stringify(s)) : res.stdout.split("\n").filter(Boolean);
        const states = lines.map((l) => {
          try {
            return JSON.parse(l) as { State?: string; Health?: string };
          } catch {
            return null;
          }
        });
        if (states.length > 0 && states.every(Boolean)) {
          const allUp = states.every(
            (s: { State?: string; Health?: string } | null) => s!.State === "running" && (!s!.Health || s!.Health === "healthy"),
          );
          if (allUp) return true;
        }
      }
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  onOutput(`last compose ps output:\n${last.slice(-2000)}`);
  return false;
}

async function rollback(
  state: DeployState,
  step: DeployStep,
  absPath: string,
  composeFile: string,
  envBackups: { file: string; content: Buffer }[],
  opts: DeployOptions,
): Promise<boolean> {
  const onOut = (c: string) => appendOutput(state, step, c);
  try {
    if (state.commitBefore) {
      const r = await run("git", ["reset", "--hard", state.commitBefore], {
        cwd: absPath,
        timeoutMs: 60_000,
        onOutput: onOut,
      });
      if (r.code !== 0) {
        onOut(`git reset failed: ${r.stderr}\n`);
        return false;
      }
      onOut(`reset to ${state.commitBefore.slice(0, 7)}\n`);
    }

    // Restore after git reset, which may overwrite tracked environment files.
    for (const b of envBackups) {
      fs.writeFileSync(resolveForWrite(b.file), b.content, { mode: 0o600 });
      onOut(`restored ${path.basename(b.file)}\n`);
    }

    const upArgs = ["compose", "-f", composeFile, "up", "-d"];
    if (opts.build !== false) upArgs.push("--build");
    const up = await run("docker", upArgs, { cwd: absPath, timeoutMs: 20 * 60_000, onOutput: onOut });
    if (up.code !== 0) {
      onOut(`rollback compose up failed: ${up.stderr}\n`);
      return false;
    }
    onOut("previous version restored and running\n");
    return true;
  } catch (err) {
    onOut(`rollback error: ${(err as Error).message}\n`);
    return false;
  }
}

function persist(state: DeployState): void {
  try {
    const perStep = Math.floor(MAX_LOG / Math.max(1, state.steps.length));
    const log = JSON.stringify(state.steps.map((step) => ({ ...step, output: step.output.slice(-perStep) })));
    db()
      .prepare(
        `UPDATE deploys SET status = ?, finished_at = ?, commit_after = ?, log = ?, error = ?
         WHERE id = ?`,
      )
      .run(
        state.status,
        state.finishedAt,
        state.commitAfter,
        log,
        state.error,
        state.id,
      );
  } catch {
    /* non-fatal */
  }
}

export interface DeployHistoryRow {
  id: string;
  project: string;
  branch: string | null;
  status: string;
  started_at: number;
  finished_at: number | null;
  commit_before: string | null;
  commit_after: string | null;
  log: string | null;
  error: string | null;
  abs_path: string | null;
}

export function deployHistory(limit = 25): DeployHistoryRow[] {
  return db()
    .prepare("SELECT * FROM deploys ORDER BY started_at DESC LIMIT ?")
    .all(Math.min(limit, 200)) as DeployHistoryRow[];
}
