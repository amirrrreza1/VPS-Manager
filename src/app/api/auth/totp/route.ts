import { NextResponse } from "next/server";
import { requireAuth, fail, clientMeta } from "@/lib/api-guard";
import { getUserById, setTotpSecret, verifyPassword, destroyAllSessions, createSession, buildSessionCookie } from "@/lib/auth";
import { generateTotpSecret, generateRecoveryCodes, hashRecoveryCodes, verifyTotp } from "@/lib/totp";
import { getSetting, setSetting } from "@/lib/db";
import { audit } from "@/lib/audit";
import QRCode from "qrcode";
import { rateLimit } from "@/lib/rate-limit";

/** Step 1: issue a secret + QR. Step 2 (action=activate): confirm a live code. */

export async function GET(req: Request) {
  const auth = await requireAuth(req, "totp.status");
  if ("response" in auth) return auth.response;
  return NextResponse.json({ hasTotp: auth.user.hasTotp });
}

export async function POST(req: Request) {
  const auth = await requireAuth(req, "totp.setup");
  if ("response" in auth) return auth.response;

  const meta = clientMeta(req);
  const body = (await req.json().catch(() => null)) as { action?: string; code?: string; password?: string } | null;
  if (!body || [body.action, body.code, body.password].some((v) => v !== undefined && typeof v !== "string")) return fail("invalid request");
  const action = body?.action ?? "start";

  if (!rateLimit(`totp-setup:${auth.user.id}`, 10, 10 * 60_000)) {
    return fail("too many attempts", 429);
  }

  const user = getUserById(auth.user.id);
  if (!user) return fail("user not found", 404);

  if (action === "start") {
    if (user.totp_secret) return fail("two-factor authentication is already enabled", 409);
    const { secret, uri } = generateTotpSecret(user.username);
    const qr = await QRCode.toDataURL(uri, { margin: 1, width: 240 });
    setSetting(`totp_pending:${auth.user.id}`, secret);
    setSetting(`totp_pending_expires:${auth.user.id}`, String(Date.now() + 10 * 60_000));
    audit({ user: user.username, action: "totp.setup_started", ip: meta.ip });
    return NextResponse.json({ ok: true, secret, qr, uri });
  }

  if (action === "activate") {
    if (user.totp_secret) return fail("two-factor authentication is already enabled", 409);
    const pending = getSetting(`totp_pending:${auth.user.id}`);
    if (!pending || Number(getSetting(`totp_pending_expires:${auth.user.id}`) ?? 0) <= Date.now()) return fail("setup expired, start setup again", 400);

    if (!verifyTotp(body?.code ?? "", pending)) {
      return fail("invalid code", 401);
    }

    const codes = generateRecoveryCodes();
    setTotpSecret(auth.user.id, pending);
    setSetting(`totp_recovery:${auth.user.id}`, hashRecoveryCodes(codes));
    setSetting(`totp_pending:${auth.user.id}`, "");
    destroyAllSessions(user.id);
    const session = createSession(user.id, meta);

    audit({ user: user.username, action: "totp.activated", ip: meta.ip });
    const response = NextResponse.json({ ok: true, recoveryCodes: codes });
    response.headers.append("Set-Cookie", buildSessionCookie(session.token, session.expiresAt));
    return response;
  }

  if (action === "disable") {
    if ((body.password?.length ?? 0) > 200 || !verifyPassword(user, body.password ?? "") ||
      !user.totp_secret || !verifyTotp(body.code ?? "", user.totp_secret)) return fail("current password and authenticator code required", 401);
    setTotpSecret(auth.user.id, null);
    setSetting(`totp_recovery:${auth.user.id}`, "");
    setSetting(`totp_pending:${auth.user.id}`, "");
    destroyAllSessions(user.id);
    const session = createSession(user.id, meta);
    audit({ user: user.username, action: "totp.disabled", ip: meta.ip });
    const response = NextResponse.json({ ok: true });
    response.headers.append("Set-Cookie", buildSessionCookie(session.token, session.expiresAt));
    return response;
  }

  return fail("unknown action", 400);
}
