import { NextResponse } from "next/server";
import { requireAuth, fail } from "@/lib/api-guard";
import { createShare, listShares, revokeShare } from "@/lib/shares";
import { PathError } from "@/lib/safe-path";

function shareError(error: unknown) {
  return error instanceof PathError ? fail(error.message, error.status) : fail("Unable to manage download links", 500);
}

export async function GET(req: Request) {
  const auth = await requireAuth(req, "shares.list");
  if ("response" in auth) return auth.response;
  try { return NextResponse.json({ shares: listShares(new URL(req.url).searchParams.get("path"), auth.user) }); }
  catch (error) { return shareError(error); }
}

export async function POST(req: Request) {
  const auth = await requireAuth(req, "shares.create");
  if ("response" in auth) return auth.response;
  const body = await req.json().catch(() => null);
  if (!body || typeof body.path !== "string" || typeof body.lifetimeMs !== "number" || typeof body.oneTime !== "boolean") return fail("Invalid link settings");
  try { return NextResponse.json(createShare(body.path, body.lifetimeMs, body.oneTime, auth.user, auth.meta.ip)); }
  catch (error) { return shareError(error); }
}

export async function DELETE(req: Request) {
  const auth = await requireAuth(req, "shares.revoke");
  if ("response" in auth) return auth.response;
  const body = await req.json().catch(() => null);
  if (!body || typeof body.id !== "string" || !/^[a-f0-9-]{36}$/.test(body.id)) return fail("Invalid link ID");
  try { revokeShare(body.id, auth.user, auth.meta.ip); return NextResponse.json({ ok: true }); }
  catch (error) { return shareError(error); }
}
