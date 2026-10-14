import { NextResponse } from "next/server";
import { requireAuth, fail } from "@/lib/api-guard";
import {
  startDeploy,
  listActiveDeploys,
  getDeploy,
  deployHistory,
  abortDeploy,
  type DeployOptions,
  type DeployHistoryRow,
} from "@/lib/deploy";
import { PathError, resolveDir } from "@/lib/safe-path";
import { db } from "@/lib/db";

export async function GET(req: Request) {
  const auth = await requireAuth(req, "deploy.status");
  if ("response" in auth) return auth.response;

  const url = new URL(req.url);
  const id = url.searchParams.get("id");

  if (id) {
    const live = getDeploy(id);
    if (live) return NextResponse.json(live);
    const row = db().prepare("SELECT * FROM deploys WHERE id = ?").get(id) as
      | DeployHistoryRow
      | undefined;
    if (!row) return fail("deploy not found", 404);
    return NextResponse.json({
      id: row.id,
      project: row.project,
      branch: row.branch,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      commitBefore: row.commit_before,
      commitAfter: row.commit_after,
      steps: row.log ? JSON.parse(row.log) : [],
      error: row.error,
    });
  }

  return NextResponse.json({
    active: listActiveDeploys(),
    history: deployHistory(30),
  });
}

export async function POST(req: Request) {
  const auth = await requireAuth(req, "deploy.start");
  if ("response" in auth) return auth.response;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return fail("invalid request");

  const projectPath = String(body.project ?? "");
  if (!projectPath) return fail("project is required");

  // A second deploy of the same project is refused - concurrent compose runs
  // on one directory corrupt state.
  let resolved: string;
  try { resolved = resolveDir(projectPath); }
  catch (err) { return fail((err as Error).message, err instanceof PathError ? err.status : 400); }
  const running = listActiveDeploys().find((d) => d.absPath === resolved);
  if (running) return fail(`a deploy is already running for ${running.project}`, 409);

  const opts: DeployOptions = {
    usePull: body.usePull === true,
    branch: typeof body.branch === "string" && body.branch ? body.branch : undefined,
    build: body.build !== false,
    healthTimeoutSec:
      body.healthTimeoutSec === undefined || body.healthTimeoutSec === null || body.healthTimeoutSec === ""
        ? 0
        : Math.max(0, Math.min(600, Number(body.healthTimeoutSec) || 0)),
    autoRollback: body.autoRollback === true,
    backupEnv: body.backupEnv !== false,
  };

  try {
    const handle = startDeploy(resolved, opts, {
      user: auth.user.username,
      ip: auth.meta.ip,
    });

    // Kick off the async pipeline; the client follows /api/deploy?id=... or the
    // SSE stream. Errors are captured inside the pipeline itself.
    void handle.promise.catch(() => undefined);

    return NextResponse.json({ ok: true, id: handle.id });
  } catch (err) {
    if (err instanceof PathError) return fail(err.message, err.status);
    return fail((err as Error).message, 400);
  }
}

export async function DELETE(req: Request) {
  const auth = await requireAuth(req, "deploy.abort");
  if ("response" in auth) return auth.response;

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return fail("id is required");

  const { audit } = await import("@/lib/audit");
  audit({ user: auth.user.username, ip: auth.meta.ip, action: "deploy.abort_requested", target: id });

  // Abort is cooperative: we do not kill a running docker/git command mid-write,
  // but the pipeline stops before the next step.
  if (!abortDeploy(id)) return fail("deploy not running", 409);
  return NextResponse.json({ ok: true, message: "abort requested" });
}
