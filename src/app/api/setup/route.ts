import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";

export async function POST(req: Request) {
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
