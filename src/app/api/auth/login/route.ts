import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { rateLimit, resetRateLimit } from "@/lib/rate-limit";
import { verifyPassword, getUserByName, createSession, buildSessionCookie, sessionCookieName,
  createLoginChallenge, getLoginChallenge, consumeLoginChallenge, clearSessionCookie } from "@/lib/auth";
import { verifyTotp, consumeRecoveryCode } from "@/lib/totp";
import { audit } from "@/lib/audit";
import { clientMeta, sameOrigin, fail } from "@/lib/api-guard";

/**
 * Login: password, then TOTP if enabled.
 * The password step issues a short-lived "pre-session" cookie; TOTP is verified
 * against that so a correct password alone is never enough.
 */

const PRE_COOKIE = "vpm_pre";
const PRE_TTL_MS = 5 * 60 * 1000;

export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail("cross-origin request rejected", 403);
  const meta = clientMeta(req);

  const body = (await req.json().catch(() => null)) as {
    username?: string;
    password?: string;
    totp?: string;
    preToken?: string;
    phase?: "password" | "totp";
  } | null;

  if (!body || (body.phase !== undefined && !["password", "totp"].includes(body.phase)) ||
    [body.username, body.password, body.totp].some((value) => value !== undefined && typeof value !== "string")) {
    return fail("invalid request");
  }
  if ((body.password?.length ?? 0) > 200 || (body.totp?.length ?? 0) > 64) return fail("invalid request");

  const store = await cookies();

  // ---- phase 2: TOTP ----------------------------------------------------
  if (body.phase === "totp") {
    const pre = store.get(PRE_COOKIE)?.value;
    if (!pre) {
      return NextResponse.json({ error: "session expired, log in again" }, { status: 401 });
    }
    const user = getLoginChallenge(pre);
    if (!user) return fail("session expired, log in again", 401);
    if (!user?.totp_secret) {
      return NextResponse.json({ error: "2FA not enabled" }, { status: 400 });
    }
    if (!rateLimit(`totp:${meta.ip}`, 10, 5 * 60_000)) {
      return NextResponse.json({ error: "too many attempts" }, { status: 429 });
    }
    if (!verifyTotp(body.totp ?? "", user.totp_secret) && !consumeRecoveryCode(user.id, body.totp ?? "")) {
      audit({ user: user.username, action: "auth.totp_failed", ip: meta.ip, ok: false });
      return NextResponse.json({ error: "invalid code" }, { status: 401 });
    }
    resetRateLimit(`totp:${meta.ip}`);
    resetRateLimit(`login:${meta.ip}`);
    consumeLoginChallenge(pre);

    const { token, expiresAt } = createSession(user.id, meta);
    const res = NextResponse.json({ ok: true, redirect: "/dashboard" });
    res.headers.append("Set-Cookie", buildSessionCookie(token, expiresAt));
    res.headers.append("Set-Cookie", clearPre());
    audit({ user: user.username, action: "auth.login", ip: meta.ip, detail: { mfa: true } });
    return res;
  }

  // ---- phase 1: password ------------------------------------------------
  const username = (body.username ?? "").trim();
  const ip = meta.ip;

  if (!rateLimit(`login:${ip}`, 10, 10 * 60_000)) {
    audit({ user: username, action: "auth.rate_limited", ip, ok: false });
    return NextResponse.json({ error: "too many attempts, try again later" }, { status: 429 });
  }

  const user = getUserByName(username);
  if (!verifyPassword(user, body.password ?? "")) {
    audit({ user: username, action: "auth.bad_password", ip, ok: false });
    return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  }

  if (user!.totp_secret) {
    const res = NextResponse.json({ ok: true, needsTotp: true });
    res.headers.append("Set-Cookie", buildPreCookie(createLoginChallenge(user!.id)));
    return res;
  }

  const { token, expiresAt } = createSession(user!.id, meta);
  const res = NextResponse.json({ ok: true, redirect: "/dashboard" });
  res.headers.append("Set-Cookie", buildSessionCookie(token, expiresAt));
  resetRateLimit(`login:${ip}`);
  audit({ user: username, action: "auth.login", ip, detail: { mfa: false } });
  return res;
}

function buildPreCookie(token: string): string {
  return [
    `${PRE_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    ...(process.env.NODE_ENV === "production" ? ["Secure"] : []),
    `Max-Age=${PRE_TTL_MS / 1000}`,
  ].join("; ");
}

function clearPre(): string {
  return `${PRE_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export async function DELETE(req: Request) {
  if (!sameOrigin(req)) return fail("cross-origin request rejected", 403);
  const { destroySession } = await import("@/lib/auth");
  const store = await cookies();
  destroySession(store.get(sessionCookieName())?.value);
  const res = NextResponse.json({ ok: true });
  res.headers.append("Set-Cookie", clearPre());
  res.headers.append("Set-Cookie", clearSessionCookie());
  return res;
}
