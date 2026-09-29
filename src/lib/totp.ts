import "server-only";
import crypto from "node:crypto";
import { authenticator } from "otplib";

/** TOTP + recovery codes. Kept separate from auth.ts so otplib is easy to swap. */

const RECOVERY_CODES = 10;

export function generateTotpSecret(username: string): { secret: string; uri: string } {
  const secret = authenticator.generateSecret();
  const uri = authenticator.keyuri(username, "VPS Manager", secret);
  return { secret, uri };
}

export function verifyTotp(token: string, secret: string): boolean {
  const cleaned = token.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(cleaned)) return false;
  try {
    return authenticator.verify({ token: cleaned, secret });
  } catch {
    return false;
  }
}

export function generateRecoveryCodes(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODES; i++) {
    const raw = crypto.randomBytes(5).toString("hex").toUpperCase();
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
  }
  return codes;
}

export function hashRecoveryCodes(codes: string[]): string {
  const digest = codes
    .map((c) => crypto.createHash("sha256").update(normalize(c)).digest("hex"))
    .sort()
    .join(",");
  return digest;
}

export function normalize(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function matchesRecoveryCode(storedDigest: string, submitted: string): boolean {
  const normalized = normalize(submitted);
  if (normalized.length !== 10) return false;
  const candidate = crypto.createHash("sha256").update(normalized).digest("hex");
  const set = new Set(storedDigest.split(","));
  return set.has(candidate);
}
