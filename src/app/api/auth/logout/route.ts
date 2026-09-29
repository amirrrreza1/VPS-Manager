import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { destroySession, clearSessionCookie } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { clientMeta } from "@/lib/api-guard";

export async function POST(req: Request) {
  const meta = clientMeta(req);
  const store = await cookies();
  destroySession(store.get("vpm_session")?.value);
  audit({ action: "auth.logout", ip: meta.ip });
  const res = NextResponse.json({ ok: true, redirect: "/login" });
  res.headers.append("Set-Cookie", clearSessionCookie());
  return res;
}
