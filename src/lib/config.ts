import path from "node:path";
import fs from "node:fs";

/**
 * Central configuration.
 *
 * Everything the app is allowed to touch is derived from ROOTS. Nothing in the
 * codebase should ever build a filesystem path from user input without going
 * through lib/safe-path.ts, which enforces this boundary.
 */

const isWindows = process.platform === "win32";

// On the VPS these default to /opt. Locally (dev on Windows/macOS) we fall back
// to a sandboxed directory inside the repo so the app is runnable and testable
// off-target without ever defaulting to the real drive root.
const DEFAULT_ROOTS = isWindows
  ? [path.join(process.cwd(), ".dev-root")]
  : ["/opt"];

function envRoots(): string[] {
  const raw = process.env.VPM_ROOTS;
  if (!raw) return DEFAULT_ROOTS;
  return raw
    .split(path.delimiter === ";" && isWindows ? ";" : ":")
    .map((s) => s.trim())
    .filter(Boolean);
}

export { envRoots };

function devSeed() {
  if (!isWindows) return;
  for (const r of DEFAULT_ROOTS) {
    try {
      fs.mkdirSync(path.join(r, "demo-api"), { recursive: true });
      const envPath = path.join(r, "demo-api", ".env");
      if (!fs.existsSync(envPath)) {
        fs.writeFileSync(
          envPath,
          [
            "# NOTE: real secrets live only on the server",
            "DATABASE_URL=postgres://user:changeme@localhost:5432/app",
            "SESSION_SECRET=replace-me",
            "NODE_ENV=production",
            "",
          ].join("\n"),
          "utf8",
        );
      }
      const idx = path.join(r, "demo-api", "index.ts");
      if (!fs.existsSync(idx)) {
        fs.writeFileSync(
          idx,
          [
            "export async function main(): Promise<void> {",
            "  const port = Number(process.env.PORT ?? 3000);",
            "  console.log(`listening on ${port}`);",
            "}",
            "",
          ].join("\n"),
          "utf8",
        );
      }
      const compose = path.join(r, "demo-api", "docker-compose.yml");
      if (!fs.existsSync(compose)) {
        fs.writeFileSync(
          compose,
          [
            "services:",
            "  app:",
            "    build: .",
            "    restart: unless-stopped",
            "    env_file: .env",
            "",
          ].join("\n"),
          "utf8",
        );
      }
    } catch {
      /* seeding is best-effort */
    }
  }
}

devSeed();

export const IS_WINDOWS = isWindows;
export const DATA_DIR =
  process.env.VPM_DATA_DIR ?? path.join(process.cwd(), ".vpm-data");
export const DB_PATH = path.join(DATA_DIR, "vpm.db");

/** Files that should never be served verbatim in the editor. */
export const SECRET_FILE_PATTERNS = [
  /^\.env(\..+)?$/i,
  /\.env$/i,
  /id_(rsa|ed25519|ecdsa|dsa)$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.pgpass$/i,
  /credentials(\.json|\.yml)?$/i,
  /secrets?\.(ya?ml|json|toml|ini)$/i,
];

/** Directories never walked or listed. */
export const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "vendor",
  "coverage",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
]);

/** Extensions the editor will open. Anything else gets a download instead. */
export const EDITABLE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".py", ".rb", ".go", ".rs", ".php", ".java", ".kt", ".swift",
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".conf", ".cfg",
  ".env", ".sh", ".bash", ".zsh", ".sql", ".md", ".mdx", ".txt", ".html",
  ".css", ".scss", ".less", ".xml", ".dockerfile", ".gitignore",
  ".editorconfig", ".prettierrc", ".eslintrc", ".proto", ".graphql",
  ".tf", ".tfvars", ".service", ".nginx", ".conf.sample", "",
]);

/** Largest file the editor will load into memory (bytes). */
export const MAX_EDIT_BYTES = Number(process.env.VPM_MAX_EDIT_BYTES ?? 2 * 1024 * 1024);
export const MAX_UPLOAD_BYTES = Number(
  process.env.VPM_MAX_UPLOAD_BYTES ?? 25 * 1024 * 1024,
);
