import "server-only";
import { NextResponse } from "next/server";
import { getSessionUser, type SessionUser } from "./auth";
import { audit } from "./audit";

/**
 * Guard for every API route. Returns either a NextResponse (reject) or the
 * authenticated user. Also enforces a same-origin check on mutations so a
 * logged-in browser cannot be CSRF'd from another site (SameSite=Strict
 * covers the cookie, this covers defence in depth).
 */

export interface ClientMeta {
  ip: string;
  userAgent: string;
}

export function clientMeta(req: Request): ClientMeta {
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  const ip = fwd.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
  return { ip, userAgent: (req.headers.get("user-agent") ?? "unknown").slice(0, 300) };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function sameOrigin(req: Request): boolean {
  if (SAFE_METHODS.has(req.method)) return true;
  const origin = req.headers.get("origin");
  if (!origin) return true; // same-origin form posts / curl may omit it
  try {
    const url = new URL(req.url);
    const o = new URL(origin);
    return o.host === url.host;
  } catch {
    return false;
  }
}

export async function requireAuth(
  req: Request,
  action = "api.access",
): Promise<{ user: SessionUser; meta: ClientMeta } | { response: NextResponse }> {
  const meta = clientMeta(req);

  if (!sameOrigin(req)) {
    audit({ user: null, action: "csrf.blocked", target: req.url, ip: meta.ip, ok: false });
    return {
      response: NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 }),
    };
  }

  const user = await getSessionUser();
  if (!user) {
    audit({ user: null, action: "auth.denied", target: action, ip: meta.ip, ok: false });
    return { response: NextResponse.json({ error: "authentication required" }, { status: 401 }) };
  }

  return { user, meta };
}

export function fail(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}
