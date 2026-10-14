import { NextResponse } from "next/server";
import { requireAuth, fail } from "@/lib/api-guard";
import { run } from "@/lib/exec";
import { resolveDir, PathError } from "@/lib/safe-path";
import { getProject } from "@/lib/projects";

/** Read-only container inspection: list, logs, stats. No mutation. */

const SAFE_LOG_ARGS = new Set(["logs", "ps"]);

export async function GET(req: Request) {
  const auth = await requireAuth(req, "docker.inspect");
  if ("response" in auth) return auth.response;

  const url = new URL(req.url);
  const project = url.searchParams.get("project");
  const action = url.searchParams.get("action") ?? "ps";
  const service = url.searchParams.get("service") ?? undefined;
  const tail = Math.max(1, Math.min(2000, Number(url.searchParams.get("tail") ?? 200)));

  if (!project) return fail("project is required");
  if (!SAFE_LOG_ARGS.has(action)) return fail("unsupported action", 400);
  if (service && (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(service))) return fail("invalid service", 400);

  try {
    const cwd = resolveDir(project);
    const info = getProject(cwd);
    if (!info.composeFile) return fail("project has no compose file");
    const args = ["compose", "-f", info.composeFile];
    if (action === "logs") {
      args.push("logs", "--no-color", "-t", "--tail", String(Number.isFinite(tail) ? tail : 200));
      if (service) args.push(service);
    } else if (action === "ps") {
      args.push("ps", "--all", "--format", "json");
    } else {
      return fail("unsupported action", 400);
    }

    const res = await run("docker", args, { cwd, timeoutMs: 30_000 });
    if (res.code !== 0) {
      return NextResponse.json({ ok: false, error: res.stderr || res.stdout, raw: res.stdout }, { status: 502 });
    }
    return NextResponse.json({ ok: true, output: res.stdout });
  } catch (err) {
    if (err instanceof PathError) return fail(err.message, err.status);
    return fail((err as Error).message, 500);
  }
}
