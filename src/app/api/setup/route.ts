import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { sameOrigin, fail } from "@/lib/api-guard";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail("cross-origin request rejected", 403);
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || "unknown";
  if (!rateLimit(`setup:${ip}`, 5, 60_000)) {
    return NextResponse.json({ error: "too many attempts" }, { status: 429 });
  }

  const { countUsers, createUser } = await import("@/lib/auth");
  if (countUsers() > 0) {
    return NextResponse.json(
      { error: "Setup already completed. Use the login page." },
      { status: 409 },
    );
  }

  const body = (await req.json().catch(() => null)) as {
    username?: string;
    password?: string;
  } | null;

  if (!body || typeof body.username !== "string" || typeof body.password !== "string") return fail("invalid request");
  // Recheck after reading the asynchronous body: only one account can exist.
  if (countUsers() > 0) return fail("Setup already completed. Use the login page.", 409);
  const username = (body?.username ?? "").trim();
  const password = body?.password ?? "";

  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    return NextResponse.json({ error: "Username must be 3-32 chars (a-z, 0-9, . _ -)" }, { status: 400 });
  }
  if (password.length < 12) {
    return NextResponse.json({ error: "Password must be at least 12 characters" }, { status: 400 });
  }
  if (password.length > 200) {
    return NextResponse.json({ error: "Password too long" }, { status: 400 });
  }

  const user = createUser(username, password);
  const { audit } = await import("@/lib/audit");
  audit({ user: username, action: "setup.complete", ip });

  return NextResponse.json({ ok: true, username: user.username });
}
