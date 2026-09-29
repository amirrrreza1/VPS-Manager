import "server-only";
import fs from "node:fs";
import path from "node:path";
import { runSyncOrThrow, hasBinary, type RunResult } from "./exec";
import { resolveDir, resolveSafe, toDisplayPath } from "./safe-path";
import { envRoots } from "./roots";

/**
 * Project discovery + git/compose inspection.
 * A "project" is any directory under a root containing a compose file and/or
 * a .git directory.
 */

const COMPOSE_FILES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  "docker-compose.prod.yml",
];

export interface ProjectInfo {
  name: string;
  /** Absolute path on disk. */
  absPath: string;
  /** Root-relative display path, e.g. /myapp */
  path: string;
  isGitRepo: boolean;
  branch: string | null;
  commit: string | null;
  commitShort: string | null;
  dirty: boolean;
  ahead: number | null;
  behind: number | null;
  remote: string | null;
  composeFile: string | null;
  services: string[];
  /** Best guess of the container image name. */
  image: string | null;
  hasEnvFile: boolean;
  envKeys: string[];
  updatedAt: number | null;
  mtimeIso: string | null;
}

function gitAvailable(): boolean {
  return hasBinary("git");
}

function safeName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(name) && name !== "." && name !== "..";
}

export function discoverProjects(): ProjectInfo[] {
  const git = gitAvailable();
  const out: ProjectInfo[] = [];

  for (const root of envRoots()) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!safeName(entry.name)) continue;
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;

      const abs = path.join(root, entry.name);
      let real: string;
      try {
        real = fs.realpathSync.native(abs);
      } catch {
        continue;
      }
      try {
        resolveSafe(real, root, { mustExist: true });
      } catch {
        continue; // symlinked out of the root
      }

      out.push(inspectProject(real, entry.name, git));
    }
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function getProject(dirPath: string, git = gitAvailable()): ProjectInfo {
  const abs = resolveDir(dirPath);
  return inspectProject(abs, path.basename(abs), git);
}

function inspectProject(abs: string, name: string, git: boolean): ProjectInfo {
  const composeFile = COMPOSE_FILES.map((f) => path.join(abs, f)).find((f) => fs.existsSync(f)) ?? null;

  const isGitRepo = fs.existsSync(path.join(abs, ".git"));
  let branch: string | null = null;
  let commit: string | null = null;
  let commitShort: string | null = null;
  let dirty = false;
  let ahead: number | null = null;
  let behind: number | null = null;
  let remote: string | null = null;

  if (isGitRepo && git) {
    const o = { cwd: abs, timeoutMs: 8000 };
    try {
      const r: RunResult = runSyncOrThrow("git", ["rev-parse", "--abbrev-ref", "HEAD"], o);
      branch = r.stdout || null;
    } catch { /* detached/empty repo */ }
    try {
      const r = runSyncOrThrow("git", ["rev-parse", "HEAD"], o);
      commit = r.stdout || null;
      commitShort = commit?.slice(0, 7) ?? null;
    } catch { /* no commits yet */ }
    try {
      const r = runSyncOrThrow("git", ["status", "--porcelain"], o);
      dirty = r.stdout.length > 0;
    } catch { /* ignore */ }
    try {
      const r = runSyncOrThrow("git", ["remote", "get-url", "origin"], o);
      remote = r.stdout || null;
    } catch { /* no remote */ }
    if (branch) {
      try {
        const r = runSyncOrThrow("git", ["rev-list", "--left-right", "--count", `origin/${branch}...HEAD`], o);
        const [b, a] = r.stdout.split(/\s+/).map((n) => Number(n) || 0);
        behind = b ?? null;
        ahead = a ?? null;
      } catch { /* upstream not fetched yet */ }
    }
  }

  let services: string[] = [];
  let image: string | null = null;
  if (composeFile) {
    const parsed = parseCompose(composeFile);
    services = parsed.services;
    image = parsed.image;
  }

  const envFile = [".env", ".env.production", ".env.local"]
    .map((f) => path.join(abs, f))
    .find((f) => fs.existsSync(f));
  const envKeys = envFile ? parseEnvKeys(envFile) : [];

  let st: fs.Stats | null = null;
  try {
    st = fs.statSync(abs);
  } catch { /* ignore */ }

  return {
    name,
    absPath: abs,
    path: toDisplayPath(abs),
    isGitRepo,
    branch,
    commit,
    commitShort,
    dirty,
    ahead,
    behind,
    remote,
    composeFile: composeFile ? path.basename(composeFile) : null,
    services,
    image,
    hasEnvFile: !!envFile,
    envKeys,
    updatedAt: st?.mtimeMs ?? null,
    mtimeIso: st ? new Date(st.mtimeMs).toISOString() : null,
  };
}

/** Minimal compose reader: enough for service names and an image name. */
function parseCompose(file: string): { services: string[]; image: string | null } {
  try {
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);
    const services: string[] = [];
    let image: string | null = null;
    let inServices = false;
    let servicesIndent = 0;
    let inService = false;
    let serviceIndent = 0;

    for (const raw of lines) {
      if (raw.trim().startsWith("#") || raw.trim() === "") continue;
      const indent = raw.length - raw.trimStart().length;

      if (!inServices) {
        if (/^services:\s*$/.test(raw)) {
          inServices = true;
          servicesIndent = indent;
        }
        continue;
      }

      if (indent <= servicesIndent) {
        inServices = false;
        continue;
      }

      const line = raw.trim();

      if (!inService) {
        const m = line.match(/^([A-Za-z0-9._-]+):\s*$/);
        if (m) {
          services.push(m[1]);
          inService = true;
          serviceIndent = indent;
        } else if (line.startsWith("image:")) {
          image = line.slice(6).trim();
        }
        continue;
      }

      if (indent <= serviceIndent) {
        inService = false;
        if (line.startsWith("image:")) image = line.slice(6).trim();
        continue;
      }
      if (line.startsWith("image:") && !image) image = line.slice(6).trim();
    }
    return { services, image };
  } catch {
    return { services: [], image: null };
  }
}

/** Read only the KEY names from an env file - never the values. */
function parseEnvKeys(file: string): string[] {
  try {
    const text = fs.readFileSync(file, "utf8");
    const keys: string[] = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (m) keys.push(m[1]);
    }
    return [...new Set(keys)].sort();
  } catch {
    return [];
  }
}

export function gitAvailableOnServer(): boolean {
  return gitAvailable();
}
