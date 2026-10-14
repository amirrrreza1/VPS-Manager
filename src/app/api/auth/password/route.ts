import { NextResponse } from "next/server";
import { requireAuth, fail } from "@/lib/api-guard";
import { getUserById, verifyPassword, setPassword, destroyAllSessions, createSession, buildSessionCookie } from "@/lib/auth";
import { verifyTotp } from "@/lib/totp";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";

export async function POST(req: Request) {
  const auth = await requireAuth(req, "auth.password_change");
  if ("response" in auth) return auth.response;
  if (!rateLimit(`password:${auth.user.id}`, 5, 10 * 60_000)) return fail("too many attempts", 429);
  const body = await req.json().catch(() => null);
  if (!body || typeof body.currentPassword !== "string" || typeof body.newPassword !== "string" ||
    (body.code !== undefined && typeof body.code !== "string")) return fail("invalid request");
  if (body.currentPassword.length > 200 || body.newPassword.length < 12 || body.newPassword.length > 200) {
    return fail("password must be 12–200 characters");
  }
  const user = getUserById(auth.user.id);
  if (!user || !verifyPassword(user, body.currentPassword) ||
    (user.totp_secret && !verifyTotp(body.code ?? "", user.totp_secret))) {
    audit({ user: auth.user.username, action: "auth.password_change_failed", ip: auth.meta.ip, ok: false });
    return fail("current password or authenticator code is incorrect", 401);
  }
  setPassword(user.id, body.newPassword);
  destroyAllSessions(user.id);
  const session = createSession(user.id, auth.meta);
  audit({ user: user.username, action: "auth.password_changed", ip: auth.meta.ip });
  const response = NextResponse.json({ ok: true });
  response.headers.append("Set-Cookie", buildSessionCookie(session.token, session.expiresAt));
  return response;
}
