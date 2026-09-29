import { NextResponse } from "next/server";
import { requireAuth, fail } from "@/lib/api-guard";
import { run } from "@/lib/exec";
import { resolveDir, PathError } from "@/lib/safe-path";

/** Read-only container inspection: list, logs, stats. No mutation. */

const SAFE_LOG_ARGS = new Set(["compose", "logs", "ps", "top", "port", "config", "images", "version"]);

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

  try {
    const cwd = resolveDir(project);
    const args = ["compose", "ps", "--format", "json"];
    if (action === "logs") {
      args[0] = "compose";
      args.splice(1, 1, "logs", "-t", "--tail", String(tail));
      if (service) args.push(service);
    } else if (action === "ps") {
      // default
    } else {
      return fail("unsupported action", 400);
    }

    const res = await run("docker", args, { cwd, timeoutMs: 30_000 });
    if (res.code !== 0) {
      return NextResponse.json({ ok: false, error: res.stderr || res.stdout, raw: res.stdout });
    }
    return NextResponse.json({ ok: true, output: res.stdout });
  } catch (err) {
    if (err instanceof PathError) return fail(err.message, err.status);
    return fail((err as Error).message, 500);
  }
}
