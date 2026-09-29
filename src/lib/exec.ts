import "server-only";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { resolveDir } from "./safe-path";
import { envRoots } from "./roots";

/**
 * Subprocess execution.
 *
 * HARD RULE: arguments are always passed as an array to spawn() with
 * shell:false. There is no code path in this app that concatenates user input
 * into a shell command string. A project name is validated against a strict
 * charset before it ever becomes a path, and paths are re-validated by
 * safe-path.ts before use.
 */

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface RunOptions {
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  input?: string;
  /** Called with each chunk as it arrives (for streaming deploy logs). */
  onOutput?: (chunk: string) => void;
  maxBuffer?: number;
}

const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * A deliberately small environment for child processes.
 *
 * Do NOT strip these. `docker compose` is a CLI plugin, and the Docker CLI
 * discovers plugins through $HOME/.docker/cli-plugins or $DOCKER_CONFIG. If
 * HOME is missing, `docker compose` silently degrades to "unknown command",
 * which is exactly the failure this app cannot tolerate.
 */
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? process.env.USERPROFILE ?? "",
    LANG: "C.UTF-8",
    GIT_TERMINAL_PROMPT: "0", // never block on a credential prompt
    GIT_ASKPASS: "echo",
  };
  // Docker CLI plugin discovery + config
  if (process.env.DOCKER_CONFIG) env.DOCKER_CONFIG = process.env.DOCKER_CONFIG;
  if (process.env.DOCKER_HOST) env.DOCKER_HOST = process.env.DOCKER_HOST;
  if (process.env.DOCKER_CONTEXT) env.DOCKER_CONTEXT = process.env.DOCKER_CONTEXT;
  if (process.env.DOCKER_CERT_PATH) env.DOCKER_CERT_PATH = process.env.DOCKER_CERT_PATH;
  if (process.env.DOCKER_TLS_VERIFY) env.DOCKER_TLS_VERIFY = process.env.DOCKER_TLS_VERIFY;

  // Windows binaries need these to load their DLLs.
  if (process.platform === "win32") {
    env.SystemRoot = process.env.SystemRoot ?? "C:\\Windows";
    env.PATHEXT = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
    env.USERPROFILE = process.env.USERPROFILE ?? "";
    env.ComSpec = process.env.ComSpec ?? "cmd.exe";
    env.APPDATA = process.env.APPDATA ?? "";
    env.LOCALAPPDATA = process.env.LOCALAPPDATA ?? "";

    // The Docker CLI discovers `docker compose` (a CLI plugin) by deriving
    // %ProgramFiles%\Docker\cli-plugins. Without PROGRAMFILES it reports
    // "unknown command: docker compose" and every deploy fails.
    env.PROGRAMFILES = process.env.PROGRAMFILES ?? "C:\\Program Files";
    env.ProgramW6432 =
      process.env.ProgramW6432 ?? process.env.PROGRAMFILES ?? "C:\\Program Files";
    env.PROGRAMFILES_X86 = process.env["PROGRAMFILES(X86)"] ?? "";
    env.ProgramFiles = env.PROGRAMFILES;
    env.CommonProgramFiles = process.env.CommonProgramFiles ?? "";
    env.CommonProgramW6432 = process.env.CommonProgramW6432 ?? "";
  }

  return env;
}

export class CommandError extends Error {
  readonly code: number;
  readonly stderr: string;
  constructor(message: string, code: number, stderr: string) {
    super(message);
    this.name = "CommandError";
    this.code = code;
    this.stderr = stderr;
  }
}

export function run(bin: string, args: string[], opts: RunOptions): Promise<RunResult> {
  const cwd = resolveDir(opts.cwd);
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const started = Date.now();

  // When the app runs as a non-root user, reach docker through the locked-down
  // sudoers rule in deploy/vps-manager.sudoers rather than joining the docker
  // group (which is root-equivalent). In the container image the socket is
// mounted directly, so this stays off.
  const useSudo = bin === "docker" && process.env.VPM_DOCKER_SUDO === "1";
  const command = useSudo ? "sudo" : bin;
  const commandArgs = useSudo ? ["docker", ...args] : args;

  return new Promise((resolve, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(command, commandArgs, {
      cwd,
      shell: false, // never true
      windowsHide: true,
      env: { ...baseEnv(), ...opts.env } as unknown as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new CommandError(
          `command timed out after ${timeout}ms: ${bin}`,
          -1,
          stderr.slice(-4000),
        ),
      );
    }, timeout);

    const append = (target: "out" | "err", data: Buffer) => {
      const text = data.toString("utf8");
      if (target === "out") {
        if (stdout.length < maxBuffer) stdout += text;
        opts.onOutput?.(text);
      } else {
        if (stderr.length < maxBuffer) stderr += text;
        opts.onOutput?.(text);
      }
    };

    child.stdout.on("data", (d: Buffer) => append("out", d));
    child.stderr.on("data", (d: Buffer) => append("err", d));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new CommandError(`failed to run ${bin}: ${err.message}`, -1, ""));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        durationMs: Date.now() - started,
      });
    });

    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });
}

/** Run and throw on non-zero exit. */
export async function runOrThrow(
  bin: string,
  args: string[],
  opts: RunOptions,
): Promise<RunResult> {
  const res = await run(bin, args, opts);
  if (res.code !== 0) {
    throw new CommandError(
      `${bin} ${args[0] ?? ""} failed with exit ${res.code}`,
      res.code,
      res.stderr || res.stdout,
    );
  }
  return res;
}

/**
 * Synchronous command run for read-only inspection. Kept separate from `run`
 * so discovery/listing can stay synchronous without blocking a request for
 * more than a few hundred milliseconds.
 */
export function runSync(
  bin: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number },
): RunResult {
  const cwd = resolveDir(opts.cwd);
  const started = Date.now();
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  try {
    const useSudo = bin === "docker" && process.env.VPM_DOCKER_SUDO === "1";
    const stdout = execFileSync(useSudo ? "sudo" : bin, useSudo ? ["docker", ...args] : args, {
      cwd,
      shell: false, // never true
      timeout,
      maxBuffer: DEFAULT_MAX_BUFFER,
      windowsHide: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: baseEnv() as unknown as NodeJS.ProcessEnv,
    });
    return { code: 0, stdout: stdout.trim(), stderr: "", durationMs: Date.now() - started };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; status?: number };
    if (e.code === "ENOENT") throw new CommandError(`${bin} not found`, -1, "");
    return {
      code: typeof e.status === "number" ? e.status : -1,
      stdout: (e.stdout ?? "").trim(),
      stderr: (e.stderr ?? e.message ?? "").trim(),
      durationMs: Date.now() - started,
    };
  }
}

/** Run synchronously and throw on non-zero exit. */
export function runSyncOrThrow(
  bin: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number },
): RunResult {
  const res = runSync(bin, args, opts);
  if (res.code !== 0) {
    throw new CommandError(`${bin} ${args[0] ?? ""} failed with exit ${res.code}`, res.code, res.stderr);
  }
  return res;
}

/** True when the binary is on PATH. */
export function hasBinary(bin: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(probe, [bin], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `docker compose` (the v2 plugin) actually works, not merely whether
 * the docker binary exists. The binary can be present with no compose plugin
 * installed, which makes every deploy fail with "unknown command".
 */
export function hasDockerCompose(): boolean {
  if (!hasBinary("docker")) return false;
  try {
    // NOTE: the cwd must be inside an allowed root. runSync() validates the
    // working directory through safe-path, and process.cwd() (the app's own
    // install dir) is deliberately outside those roots - passing it would
    // throw and report compose as unusable even when it works.
    const root = envRoots().find((r) => existsSync(r));
    if (!root) return false;
    const res = runSync("docker", ["compose", "version"], { cwd: root, timeoutMs: 10_000 });
    return res.code === 0;
  } catch {
    return false;
  }
}
