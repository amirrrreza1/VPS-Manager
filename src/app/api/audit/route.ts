import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-guard";
import { recentAudit } from "@/lib/audit";

export async function GET(req: Request) {
  const auth = await requireAuth(req, "audit.read");
  if ("response" in auth) return auth.response;

  const limit = Number(new URL(req.url).searchParams.get("limit") ?? 100);
  return NextResponse.json({ entries: recentAudit(limit || 100) });
}
