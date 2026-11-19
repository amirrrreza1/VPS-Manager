import { NextResponse } from "next/server";
import { requireAuth, fail } from "@/lib/api-guard";
import { backupDatabase } from "@/lib/maintenance";
import { getSetting } from "@/lib/db";
import { envRoots } from "@/lib/roots";
import { run } from "@/lib/exec";
import { audit } from "@/lib/audit";
import { listActiveDeploys } from "@/lib/deploy";

export async function GET(req: Request) {
  const auth = await requireAuth(req, "maintenance.status");
  if ("response" in auth) return auth.response;
  try {
    const usage = await run("docker", ["system", "df"], { cwd: envRoots()[0], timeoutMs: 30_000 });
    return NextResponse.json({ diskUsage: usage.code === 0 ? usage.stdout : "Docker disk usage unavailable", lastBackupAt: Number(getSetting("backup.last_at")) || null, autoBackup: process.env.VPM_AUTO_BACKUP !== "0" }, { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ diskUsage: "Docker is unavailable", lastBackupAt: Number(getSetting("backup.last_at")) || null, autoBackup: process.env.VPM_AUTO_BACKUP !== "0" }); }
}

const runtime = globalThis as typeof globalThis & { __vpmMaintenanceBusy?: boolean };
export async function POST(req: Request) {
  const auth = await requireAuth(req, "maintenance.run");
  if ("response" in auth) return auth.response;
  const body = await req.json().catch(() => null);
  if (!body || !["backup", "clean-build-cache"].includes(body.action)) return fail("unsupported maintenance action");
  if (runtime.__vpmMaintenanceBusy) return fail("maintenance already running", 409);
  runtime.__vpmMaintenanceBusy = true;
  const meta = { user: auth.user.username, ip: auth.meta.ip };
  try {
    if (body.action === "backup") return NextResponse.json({ ok: true, output: `Database snapshot saved: ${backupDatabase(meta)}` });
    if (listActiveDeploys().length) return fail("wait for deployments to finish before cleaning build cache", 409);
    const result = await run("docker", ["builder", "prune", "--force", "--filter", "until=168h"], { cwd: envRoots()[0], timeoutMs: 180_000 });
    audit({ ...meta, action: "maintenance.clean_build_cache", ok: result.code === 0 });
    if (result.code !== 0) throw new Error(result.stderr || "Build cache cleanup failed");
    return NextResponse.json({ ok: true, output: result.stdout || "No eligible build cache" });
  } catch (error) { return fail((error as Error).message); }
  finally { runtime.__vpmMaintenanceBusy = false; }
}
