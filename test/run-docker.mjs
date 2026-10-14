import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";

// All Git resets, containers and filesystem mutations belong to this fixture.
// The application image can run this same test against its mounted Docker socket.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "vpm-docker-"));
const root = path.join(temporary, "root");
const project = path.join(root, "realapp");
const seed = path.join(temporary, "seed");
const origin = path.join(temporary, "origin.git");
const data = path.join(temporary, "data");
const name = `vpm-verify-${randomUUID().slice(0, 8)}`;
const image = `${name}:app`;
const jar = new Map();
const streamAbort = new AbortController();
let server;
let serverOutput = "";
let base;
let passed = 0;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const command = (bin, args, cwd = temporary) => execFileSync(bin, args, {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  timeout: 120_000,
}).trim();
const git = (cwd, ...args) => command("git", args, cwd);
const compose = (...args) => command("docker", ["compose", "-f", "docker-compose.yml", ...args], project);
function check(label, fn) { fn(); passed++; console.log(`PASS ${label}`); }

async function call(route, { json, ...options } = {}) {
  const headers = { Origin: base, ...options.headers };
  if (jar.size) headers.Cookie = [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
  if (json) { headers["Content-Type"] = "application/json"; options.body = JSON.stringify(json); }
  const response = await fetch(`${base}${route}`, { ...options, headers, redirect: "manual", signal: options.signal ?? AbortSignal.timeout(30_000) });
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(";"); const index = pair.indexOf("=");
    if (/Max-Age=0/i.test(cookie)) jar.delete(pair.slice(0, index));
    else jar.set(pair.slice(0, index), pair.slice(index + 1));
  }
  return response;
}

async function startServer() {
  serverOutput = "";
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", new URL(base).port, "-H", "127.0.0.1"], {
    env: { ...process.env, NODE_ENV: "production", VPM_ROOTS: root, VPM_DATA_DIR: data, VPM_DOCKER_SUDO: "0", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  for (const stream of [server.stdout, server.stderr]) stream.on("data", (chunk) => { serverOutput = (serverOutput + chunk).slice(-30_000); });
  for (let i = 0; i < 100 && server.exitCode === null; i++) {
    try { if ((await fetch(`${base}/login`, { signal: AbortSignal.timeout(2000) })).ok) return; } catch { /* starting */ }
    await delay(200);
  }
  throw new Error(`Production server did not start:\n${serverOutput}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = once(server, "exit"); server.kill(); await exited;
}

function commit(label, { healthy = true, broken = false } = {}) {
  fs.writeFileSync(path.join(seed, "version.txt"), `${label}\n`);
  fs.writeFileSync(path.join(seed, "Dockerfile"), [
    "FROM node:22-alpine", "COPY version.txt /version.txt",
    ...(broken ? ["RUN echo intentional-test-build-failure && exit 1"] : []),
    `CMD ["sh", "-c", "echo started-$(cat /version.txt); ${healthy ? "touch /ready; " : ""}exec sleep 3600"]`, "",
  ].join("\n"));
  git(seed, "add", "."); git(seed, "commit", "-m", label);
  return git(seed, "rev-parse", "HEAD");
}

async function deploy(overrides = {}) {
  const response = await call("/api/deploy", { method: "POST", json: { project: "/realapp", autoRollback: true, healthTimeoutSec: 20, ...overrides } });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body)); assert.ok(body.id);
  return body.id;
}

async function waitForDeploy(id) {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const response = await call(`/api/deploy?id=${id}`); assert.equal(response.status, 200);
    const state = await response.json();
    if (!["queued", "running"].includes(state.status)) return state;
    await delay(300);
  }
  throw new Error(`Deploy ${id} timed out`);
}

async function readStream(id) {
  const response = await call(`/api/deploy/stream?id=${id}`, { signal: AbortSignal.any([streamAbort.signal, AbortSignal.timeout(240_000)]) });
  assert.equal(response.status, 200); assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let buffer = ""; let live = false; let terminal;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (!frame.startsWith("event: deploy\n")) continue;
        const state = JSON.parse(frame.slice("event: deploy\ndata: ".length));
        if (state.steps.some((step) => step.status === "running" && step.output)) live = true;
        if (!["queued", "running"].includes(state.status)) terminal = state;
      }
    }
  } finally { await reader.cancel(); }
  return { live, terminal };
}

async function assertRunning(version) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const id = compose("ps", "-q", "app");
    if (id && command("docker", ["inspect", "-f", "{{.State.Health.Status}}", id]) === "healthy") {
      assert.equal(command("docker", ["exec", id, "cat", "/version.txt"]), version); return;
    }
    await delay(300);
  }
  throw new Error(`Expected ${version} container to be healthy`);
}

try {
  if (process.env.VPM_VERIFY_CONTAINER === "1") {
    check("production container runs as a non-root user", () => assert.ok(process.getuid() > 0));
  }
  command("docker", ["info", "--format", "{{.ServerVersion}}"]);
  command("docker", ["compose", "version"]);
  fs.mkdirSync(root); fs.mkdirSync(seed);
  fs.writeFileSync(path.join(seed, ".gitignore"), ".env\n");
  fs.writeFileSync(path.join(seed, "docker-compose.yml"), [
    `name: ${name}`, "services:", "  app:", "    build: .", `    image: ${image}`,
    "    env_file: .env", "    healthcheck:", '      test: ["CMD", "test", "-f", "/ready"]',
    "      interval: 1s", "      timeout: 1s", "      retries: 2", "",
  ].join("\n"));
  git(seed, "init", "-b", "main"); git(seed, "config", "user.name", "Integration Test"); git(seed, "config", "user.email", "test@example.invalid");
  const before = commit("version-one");
  git(temporary, "clone", "--bare", seed, origin); git(seed, "remote", "add", "origin", origin);
  git(root, "clone", origin, project);
  const after = commit("version-two"); git(seed, "push", "origin", "main"); git(project, "fetch", "origin");
  const environment = "TOKEN=disposable-operator-value\n";
  fs.writeFileSync(path.join(project, ".env"), environment);
  const demo = path.join(root, "demo-api"); fs.mkdirSync(demo); fs.mkdirSync(path.join(root, "empty"));
  fs.writeFileSync(path.join(demo, "index.ts"), "export async function main() {}\n");
  fs.writeFileSync(path.join(demo, ".env"), "DATABASE_URL=postgres://user:changeme@localhost:5432/app\nSESSION_SECRET=replace-me\n");
  fs.writeFileSync(path.join(demo, "docker-compose.yml"), "services:\n  app:\n    image: alpine\n");
  const socket = net.createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
  base = `http://127.0.0.1:${socket.address().port}`; await new Promise((resolve) => socket.close(resolve));
  await startServer();
  assert.equal((await call("/api/setup", { method: "POST", json: { username: "smoke", password: "smoke-test-password-123" } })).status, 200);
  assert.equal((await call("/api/auth/login", { method: "POST", json: { username: "smoke", password: "smoke-test-password-123" } })).status, 200);
  const discovery = await (await call("/api/projects")).json();
  check("real Docker, Compose and Git project are available", () => {
    assert.equal(discovery.capabilities.dockerCompose, true);
    assert.equal(discovery.projects.find((entry) => entry.name === "realapp").behind, 1);
  });
  const id = await deploy();
  const streaming = readStream(id).catch((error) => ({ error }));
  const duplicate = await call("/api/deploy", { method: "POST", json: { project: "/realapp/." } });
  check("concurrent deploy is refused even with an alternate path", () => assert.equal(duplicate.status, 409));
  const result = await waitForDeploy(id); const events = await streaming;
  if (events.error) throw events.error;
  check("real deploy updates Git and completes every step", () => {
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    assert.equal(result.commitBefore, before); assert.equal(result.commitAfter, after);
    assert.ok(result.steps.every((step) => step.status === "ok"));
  });
  check("SSE delivers running output and the final result", () => { assert.ok(events.live); assert.equal(events.terminal.status, "succeeded"); });
  await assertRunning("version-two"); passed++; console.log("PASS deployed container is healthy and contains the new version");
  check("operator environment survives deployment", () => assert.equal(fs.readFileSync(path.join(project, ".env"), "utf8"), environment));
  for (const action of ["ps", "logs"]) {
    const response = await call(`/api/docker?project=/realapp&action=${action}`); const body = await response.json();
    check(`container ${action} is available through the API`, () => { assert.equal(response.status, 200); assert.ok(body.output.includes(action === "logs" ? "started-version-two" : name)); });
  }
  commit("broken-build", { broken: true }); git(seed, "push", "origin", "main");
  const failed = await waitForDeploy(await deploy());
  check("failed Docker build rolls back Git and reports the failure", () => {
    assert.equal(failed.status, "rolled_back", JSON.stringify(failed)); assert.match(failed.error, /compose up failed/);
    assert.equal(git(project, "rev-parse", "HEAD"), after);
  });
  await assertRunning("version-two"); passed++; console.log("PASS failed build restores the previous healthy container");
  check("failed-build rollback preserves operator environment", () => assert.equal(fs.readFileSync(path.join(project, ".env"), "utf8"), environment));
  commit("unhealthy-version", { healthy: false }); git(seed, "push", "origin", "main");
  const unhealthy = await waitForDeploy(await deploy({ healthTimeoutSec: 4 }));
  check("unhealthy deployment triggers automatic rollback", () => {
    assert.equal(unhealthy.status, "rolled_back", JSON.stringify(unhealthy)); assert.match(unhealthy.error, /health check timed out/);
    assert.equal(git(project, "rev-parse", "HEAD"), after);
  });
  await assertRunning("version-two"); passed++; console.log("PASS health-check rollback restores the previous healthy container");
  commit("version-three"); git(seed, "push", "origin", "main");
  const abortId = await deploy();
  const abortResponse = await call(`/api/deploy?id=${abortId}`, { method: "DELETE" });
  assert.equal(abortResponse.status, 200);
  const aborted = await waitForDeploy(abortId);
  check("cooperative abort restores the stack and releases the lock", () => {
    assert.equal(aborted.status, "aborted", JSON.stringify(aborted)); assert.equal(aborted.steps.at(-1).status, "ok");
    assert.equal(git(project, "rev-parse", "HEAD"), after);
  });
  await assertRunning("version-two");
  const completed = await waitForDeploy(await deploy());
  check("another deployment succeeds after an abort", () => assert.equal(completed.status, "succeeded", JSON.stringify(completed)));
  await assertRunning("version-three");
  await stopServer();
  const database = new DatabaseSync(path.join(data, "vpm.db"));
  database.prepare("INSERT INTO deploys (id, project, branch, status, started_at, abs_path) VALUES (?, ?, ?, 'running', ?, ?)").run("interrupted-test", "realapp", "main", Date.now(), project);
  database.close(); await startServer();
  const persisted = await (await call(`/api/deploy?id=${id}`)).json();
  check("deployment output and sessions survive a service restart", () => { assert.equal(persisted.status, "succeeded"); assert.equal(persisted.steps.length, result.steps.length); });
  const interrupted = await (await call("/api/deploy?id=interrupted-test")).json();
  check("restart marks interrupted deployments failed", () => { assert.equal(interrupted.status, "failed"); assert.match(interrupted.error, /service restarted/); });
  const smoke = spawn(process.execPath, ["test/e2e.mjs", base], { stdio: "inherit", windowsHide: true });
  const [code] = await once(smoke, "exit"); assert.equal(code, 0, "HTTP smoke checks failed");
  console.log(`\n${passed} real-Docker checks passed, plus the HTTP smoke suite`);
} catch (error) {
  console.error(error); console.error(serverOutput); process.exitCode = 1;
} finally {
  streamAbort.abort();
  await stopServer();
  if (fs.existsSync(path.join(project, "docker-compose.yml"))) {
    try { compose("down", "--volumes", "--remove-orphans"); } catch (error) { console.error("Fixture container cleanup failed:", error.message); process.exitCode = 1; }
  }
  try { command("docker", ["image", "rm", image]); } catch { /* an early failure may not have created the fixture image */ }
  fs.rmSync(temporary, { recursive: true, force: true });
}
