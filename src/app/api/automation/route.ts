import { NextResponse } from "next/server";
import { requireAuth, fail } from "@/lib/api-guard";
import { listAutomation, configureAutomation } from "@/lib/automation";

export async function GET(req: Request) {
  const auth = await requireAuth(req, "automation.list");
  if ("response" in auth) return auth.response;
  return NextResponse.json({ rules: listAutomation(), workerEnabled: process.env.VPM_AUTOMATION !== "0" }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(req: Request) {
  const auth = await requireAuth(req, "automation.configure");
  if ("response" in auth) return auth.response;
  const body = await req.json().catch(() => null);
  if (!body || typeof body.project !== "string" || typeof body.enabled !== "boolean" || typeof body.intervalSec !== "number") return fail("project, enabled and intervalSec are required");
  try {
    configureAutomation(body.project, body.enabled, body.intervalSec, { user: auth.user.username, ip: auth.meta.ip });
    return NextResponse.json({ ok: true });
  } catch (error) { return fail((error as Error).message); }
}
