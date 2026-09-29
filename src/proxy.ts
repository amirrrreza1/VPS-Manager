import { NextResponse, type NextRequest } from "next/server";
import { validateSessionToken, sessionCookieName } from "@/lib/auth";

/**
 * Two jobs:
 *  1. Optimistic redirect for page requests. API routes do their own
 *     authorization, so this is UX, not a security boundary.
 *  2. Security headers on every response.
 */

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApi = pathname.startsWith("/api/");

  const token = request.cookies.get(sessionCookieName())?.value;
  const session = validateSessionToken(token);

  const isPublic =
    pathname === "/login" ||
    pathname === "/setup" ||
    isApi ||
    pathname === "/";

  // Every exit path below must return a response that has been through
  // harden(): a bare NextResponse.redirect() would otherwise ship without
  // security headers.
  const harden = (response: NextResponse): NextResponse => {
    response.headers.set("X-Frame-Options", "DENY");
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("X-DNS-Prefetch-Control", "off");
    response.headers.set("Content-Security-Policy", CSP);
    response.headers.set(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), interest-cohort=()",
    );
    if (isApi) {
      response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
    }
    return response;
  };

  if (!session && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return harden(NextResponse.redirect(url));
  }

  if (session && (pathname === "/login" || pathname === "/setup")) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return harden(NextResponse.redirect(url));
  }

  return harden(NextResponse.next());
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
