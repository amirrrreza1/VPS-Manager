import "server-only";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { envRoots } from "./roots";
import { resolveDir, resolveForWrite, resolveFile } from "./safe-path";
import { getProject } from "./projects";
import { run } from "./exec";
import { audit } from "./audit";

export const TEMPLATES = ["repository", "static", "image", "postgres", "redis"] as const;
export type Template = typeof TEMPLATES[number];
export interface ProvisionOptions {
  name: string; root: string; template: Template; repository?: string;
  branch?: string; image?: string; hostPort?: number; containerPort?: number;
}

export function validateRepository(value: string): string {
  if (value.length > 2048) throw new Error("repository URL is too long");
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+$/.test(value)) return value;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("use an HTTPS or SSH repository URL"); }
  if (!["https:", "ssh:"].includes(url.protocol) || url.password || (url.protocol === "https:" && url.username) || !url.hostname || !url.pathname || /[\s\x00-\x1f]/.test(value)) {
    throw new Error("use an HTTPS or SSH repository URL without embedded credentials");
  }
  return value;
}

function port(value: unknown, fallback: number): number {
  const n = value === undefined ? fallback : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1024 || n > 65535) throw new Error("host port must be between 1024 and 65535");
  return n;
}

/** Prepare privately, then reserve the final name without replacing existing data. */
export async function provisionProject(opts: ProvisionOptions, meta: { user: string; ip: string }) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(opts.name)) throw new Error("name must use lowercase letters, numbers and hyphens (max 63)");
  if (!TEMPLATES.includes(opts.template)) throw new Error("unsupported template");
  const allowedRoot = envRoots().find((root) => path.resolve(root) === path.resolve(opts.root));
  if (!allowedRoot) throw new Error("select a configured project root");
  const root = resolveDir(allowedRoot);
  const destination = resolveForWrite(path.join(root, opts.name), root);
  if (fs.existsSync(destination)) throw new Error("a directory with that name already exists");
  if (opts.template === "repository") validateRepository(opts.repository ?? "");
  if (opts.branch && (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(opts.branch) || opts.branch.includes(".."))) throw new Error("invalid branch");
  if (opts.template === "image" && !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(opts.image ?? "")) throw new Error("invalid image reference");
  const hostPort = port(opts.hostPort, opts.template === "postgres" ? 5432 : opts.template === "redis" ? 6379 : 8080);
  const containerPort = opts.containerPort ?? (opts.template === "static" ? 80 : 3000);
  if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) throw new Error("invalid container port");
  // A private sibling keeps cloning and preparation outside project discovery.
  const staging = fs.mkdtempSync(path.join(root, ".vpm-provision-"));
  fs.chmodSync(staging, 0o700);
  const write = (name: string, content: string) => fs.writeFileSync(resolveForWrite(path.join(staging, name), root), content, { flag: "wx", mode: 0o600 });
  try {
    if (opts.template === "repository") {
      const args = ["clone", "--single-branch"];
      if (opts.branch) args.push("--branch", opts.branch);
      args.push("--", opts.repository!, staging);
      const result = await run("git", args, { cwd: root, timeoutMs: 180_000 });
      if (result.code !== 0) throw new Error("Git clone failed. Check repository access and server Git credentials.");
      const project = getProject(staging);
      if (!project.composeFile) {
        if (!fs.existsSync(path.join(staging, "Dockerfile"))) {
          const pkg = JSON.parse(fs.readFileSync(resolveFile(path.join(staging, "package.json")), "utf8")) as { scripts?: Record<string, string>; dependencies?: Record<string, string> };
          if (!pkg.scripts?.start || !fs.existsSync(path.join(staging, "package-lock.json"))) throw new Error("repository needs Compose, a Dockerfile, or an npm lockfile and start script");
          // Generate scaffolding outside the tracked tree only when absent.
          write("Dockerfile", `FROM node:22-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci\nCOPY . .\n${pkg.scripts.build ? "RUN npm run build\n" : ""}ENV NODE_ENV=production\nENV PORT=${containerPort}\nENV HOSTNAME=0.0.0.0\nEXPOSE ${containerPort}\nCMD ["npm", "start"]\n`);
          if (!fs.existsSync(path.join(staging, ".dockerignore"))) write(".dockerignore", "node_modules\n.git\n.env*\n.next\n*.bak\n");
        }
        if (!fs.existsSync(path.join(staging, ".env"))) write(".env", "# Application environment variables\n");
        write("compose.yaml", `services:\n  app:\n    build: .\n    restart: unless-stopped\n    env_file: .env\n    ports:\n      - "127.0.0.1:${hostPort}:${containerPort}"\n    environment:\n      PORT: "${containerPort}"\n`);
        // Generated deployment files should not make automated Git checks dirty.
        const exclude = resolveFile(path.join(staging, ".git", "info", "exclude"));
        fs.appendFileSync(exclude, "\n/compose.yaml\n/Dockerfile\n/.dockerignore\n/.env\n");
      }
    } else if (opts.template === "static") {
      fs.mkdirSync(path.join(staging, "public"), { mode: 0o755 });
      write("public/index.html", `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${opts.name}</title><style>body{font:18px system-ui;max-width:50rem;margin:15vh auto;padding:2rem;background:#09090b;color:#e4e4e7}h1{color:#34d399}</style><h1>${opts.name}</h1><p>Your project is running. Edit public/index.html in VPS Manager to get started.</p></html>`);
      // Bake assets into an image: host paths differ inside the manager container.
      write("Dockerfile", "FROM nginx:stable-alpine\nCOPY --chown=nginx:nginx public/ /usr/share/nginx/html/\n");
      write(".dockerignore", ".git\n.env*\n*.bak\n");
      write("compose.yaml", `services:\n  app:\n    build: .\n    restart: unless-stopped\n    ports:\n      - "127.0.0.1:${hostPort}:80"\n    healthcheck:\n      test: ["CMD", "wget", "-q", "--spider", "http://127.0.0.1"]\n      interval: 5s\n      timeout: 3s\n      retries: 6\n`);
    } else if (opts.template === "image") {
      write(".env", "# Application environment variables\n");
      write("compose.yaml", `services:\n  app:\n    image: ${JSON.stringify(opts.image)}\n    restart: unless-stopped\n    env_file: .env\n    ports:\n      - "127.0.0.1:${hostPort}:${containerPort}"\n`);
    } else if (opts.template === "postgres") {
      write(".env", `POSTGRES_USER=app\nPOSTGRES_DB=app\nPOSTGRES_PASSWORD=${crypto.randomBytes(32).toString("hex")}\n`);
      write("compose.yaml", `services:\n  db:\n    image: postgres:17-alpine\n    restart: unless-stopped\n    env_file: .env\n    ports:\n      - "127.0.0.1:${hostPort}:5432"\n    volumes:\n      - database:/var/lib/postgresql/data\n    healthcheck:\n      test: ["CMD-SHELL", "pg_isready -U $$POSTGRES_USER -d $$POSTGRES_DB"]\n      interval: 5s\n      timeout: 3s\n      retries: 12\nvolumes:\n  database:\n`);
    } else {
      write(".env", `REDIS_PASSWORD=${crypto.randomBytes(32).toString("hex")}\n`);
      write("compose.yaml", `services:\n  cache:\n    image: redis:7-alpine\n    restart: unless-stopped\n    env_file: .env\n    command: ["sh", "-c", "exec redis-server --appendonly yes --requirepass \\"$$REDIS_PASSWORD\\""]\n    ports:\n      - "127.0.0.1:${hostPort}:6379"\n    volumes:\n      - cache:/data\n    healthcheck:\n      test: ["CMD-SHELL", "REDISCLI_AUTH=$$REDIS_PASSWORD redis-cli ping | grep -q PONG"]\n      interval: 5s\n      timeout: 3s\n      retries: 6\nvolumes:\n  cache:\n`);
    }
    // mkdir reserves the name exclusively on Windows and Linux. All moves are
    // synchronous siblings on one filesystem, with no request yielding midway.
    fs.mkdirSync(destination, { mode: 0o700 });
    try {
      for (const entry of fs.readdirSync(staging)) fs.renameSync(path.join(staging, entry), path.join(destination, entry));
      fs.rmdirSync(staging);
    } catch (error) { fs.rmSync(destination, { recursive: true, force: true }); throw error; }
    audit({ ...meta, action: "project.create", target: destination, detail: { template: opts.template } });
    return getProject(destination);
  } finally {
    // This exact temporary directory was created above inside the selected root.
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
  }
}
