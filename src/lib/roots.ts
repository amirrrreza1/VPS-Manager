import path from "node:path";

/**
 * Root resolution, split out from config.ts so safe-path.ts can import it
 * without a cycle (config -> safe-path -> config).
 */

const isWindows = process.platform === "win32";

const DEFAULT_ROOTS = isWindows
  ? [path.join(process.cwd(), ".dev-root")]
  : ["/opt"];

export function envRoots(): string[] {
  const raw = process.env.VPM_ROOTS;
  if (!raw) return DEFAULT_ROOTS;
  const sep = isWindows ? ";" : ":";
  return raw
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean);
}
