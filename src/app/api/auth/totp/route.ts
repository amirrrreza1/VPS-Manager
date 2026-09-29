import { NextResponse } from "next/server";
import { requireAuth, fail, clientMeta } from "@/lib/api-guard";
import { getUserById, setTotpSecret } from "@/lib/auth";
import { generateTotpSecret, generateRecoveryCodes, hashRecoveryCodes } from "@/lib/totp";
import { getSetting, setSetting } from "@/lib/db";
import { audit } from "@/lib/audit";
import QRCode from "qrcode";
import { rateLimit } from "@/lib/rate-limit";

/** Step 1: issue a secret + QR. Step 2 (action=activate): confirm a live code. */

export async function POST(req: Request) {
  const auth = await requireAuth(req, "totp.setup");
  if ("response" in auth) return auth.response;

  const meta = clientMeta(req);
  const body = (await req.json().catch(() => null)) as { action?: string; code?: string } | null;
  const action = body?.action ?? "start";

  if (!rateLimit(`totp-setup:${auth.user.id}`, 10, 10 * 60_000)) {
    return fail("too many attempts", 429);
  }

  const user = getUserById(auth.user.id);
  if (!user) return fail("user not found", 404);

  if (action === "start") {
    const { secret, uri } = generateTotpSecret(user.username);
    const qr = await QRCode.toDataURL(uri, { margin: 1, width: 240 });
    setSetting(`totp_pending:${auth.user.id}`, secret);
    audit({ user: user.username, action: "totp.setup_started", ip: meta.ip });
    return NextResponse.json({ ok: true, secret, qr, uri });
  }

  if (action === "activate") {
    const pending = getSetting(`totp_pending:${auth.user.id}`);
    if (!pending) return fail("start setup first", 400);

    const { verifyTotp } = await import("@/lib/totp");
    if (!verifyTotp(body?.code ?? "", pending)) {
      return fail("invalid code", 401);
    }

    const codes = generateRecoveryCodes();
    setTotpSecret(auth.user.id, pending);
    setSetting(`totp_recovery:${auth.user.id}`, hashRecoveryCodes(codes));
    setSetting(`totp_pending:${auth.user.id}`, "");

    audit({ user: user.username, action: "totp.activated", ip: meta.ip });
    return NextResponse.json({ ok: true, recoveryCodes: codes });
  }

  if (action === "disable") {
    setTotpSecret(auth.user.id, null);
    setSetting(`totp_recovery:${auth.user.id}`, "");
    audit({ user: user.username, action: "totp.disabled", ip: meta.ip });
    return NextResponse.json({ ok: true });
  }

  return fail("unknown action", 400);
}
