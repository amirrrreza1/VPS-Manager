import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { destroySession, clearSessionCookie, consumeLoginChallenge } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { clientMeta, sameOrigin, fail } from "@/lib/api-guard";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail("cross-origin request rejected", 403);
  const meta = clientMeta(req);
  const store = await cookies();
  destroySession(store.get("vpm_session")?.value);
  const challenge = store.get("vpm_pre")?.value;
  if (challenge) consumeLoginChallenge(challenge);
  audit({ action: "auth.logout", ip: meta.ip });
  const res = NextResponse.json({ ok: true, redirect: "/login" });
  res.headers.append("Set-Cookie", clearSessionCookie());
  res.headers.append("Set-Cookie", "vpm_pre=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
  return res;
}
