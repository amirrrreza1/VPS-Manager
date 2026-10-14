import { NextResponse } from "next/server";
import { requireAuth, fail } from "@/lib/api-guard";
import { getServerSnapshot } from "@/lib/server-info";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const auth = await requireAuth(req, "server.inspect");
  if ("response" in auth) return auth.response;
  try {
    return NextResponse.json(await getServerSnapshot(), { headers: { "Cache-Control": "private, no-store" } });
  } catch { return fail("Unable to read server information. Please try again.", 500); }
}
