import { claimShare } from "@/lib/shares";
import { downloadResponse } from "@/lib/transfers";
import { PathError } from "@/lib/safe-path";
import { rateLimit } from "@/lib/rate-limit";
import { clientMeta } from "@/lib/api-guard";

export const runtime = "nodejs";

const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow, noarchive" };

export async function GET(req: Request, context: { params: Promise<{ token: string }> }) {
  const { ip } = clientMeta(req);
  // This public endpoint accepts only a 256-bit capability, never a file path.
  // A global bound supplements per-client limits behind a trusted reverse proxy.
  if (!rateLimit("shared:global", 600, 60_000) || !rateLimit(`shared:${ip}`, 60, 60_000)) {
    return new Response("Too many downloads. Please try again shortly.", { status: 429, headers: { ...headers, "Retry-After": "60" } });
  }
  try {
    const { token } = await context.params;
    return downloadResponse(claimShare(token, ip), req.signal);
  } catch (error) {
    return new Response("This download link is unavailable or expired.", { status: error instanceof PathError ? error.status : 404, headers });
  }
}

// Next's implicit HEAD calls GET. Do not consume one-time links during previews.
export async function HEAD() { return new Response(null, { status: 405, headers: { ...headers, Allow: "GET" } }); }
