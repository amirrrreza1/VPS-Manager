import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "vpm-pipeline-"));
const root = path.join(temporary, "root"); fs.mkdirSync(root);
process.env.VPM_ROOTS = root; process.env.VPM_DATA_DIR = path.join(temporary, "data");
const { startDeploy, abortDeploy, deployEvents, getDeploy, deployHistory } = await import("../src/lib/deploy.ts");
const { closeDb } = await import("../src/lib/db.ts");
// @ts-expect-error The fake executable is a JavaScript-only test fixture.
const { calls, healthScenarios } = await import("./fake-exec.mjs");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
let passed = 0;
function fixture(name: string) {
  const dir = path.join(root, name); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "compose.yml"), "services:\n  app:\n    image: alpine\n");
  fs.writeFileSync(path.join(dir, ".env"), "TOKEN=operator-value\n");
  return dir;
}
try {
  for (const name of ["success-array", "success-ndjson"]) {
    const dir = fixture(name);
    const handle = startDeploy(dir, { healthTimeoutSec: 1 });
    assert.throws(() => startDeploy(`${dir}${path.sep}.`), /already running/);
    const state = await handle.promise;
    assert.equal(state.status, "succeeded"); assert.ok(state.steps.every((step) => step.status === "ok"));
    assert.equal(abortDeploy(handle.id), false);
    passed++; console.log(`PASS ${name}: health output without Docker healthchecks and canonical deploy lock`);
  }
  const migrationConfig = {
    services: {
      db: {}, migrate: {},
      web: { depends_on: { migrate: { condition: "service_completed_successfully" } } },
      worker: { depends_on: { migrate: { condition: "service_completed_successfully" } } },
    },
  };
  const healthyStack = [
    { Service: "db", State: "running", Health: "healthy", ExitCode: 0 },
    { Service: "migrate", State: "exited", Health: "", ExitCode: 0 },
    { Service: "web", State: "running", Health: "healthy", ExitCode: 0 },
    { Service: "worker", State: "running", Health: "healthy", ExitCode: 0 },
  ];
  for (const name of ["migration-array", "migration-ndjson"]) {
    const dir = fixture(name);
    healthScenarios.set(dir, { config: migrationConfig, states: healthyStack });
    const state = await startDeploy(dir, { healthTimeoutSec: 1 }).promise;
    assert.equal(state.status, "succeeded", JSON.stringify(state));
    assert.ok(state.steps.every((step) => step.status === "ok"));
    passed++; console.log(`PASS ${name}: completed migration and healthy services pass deployment health`);
  }
  for (const [name, service, changes, config, configCode] of [
    ["migration-failed", "migrate", { ExitCode: 1 }, migrationConfig, 0],
    ["migration-unfinished", "migrate", { State: "running" }, migrationConfig, 0],
    ["migration-exit-unknown", "migrate", { ExitCode: undefined }, migrationConfig, 0],
    ["application-stopped", "web", { State: "exited", Health: "" }, migrationConfig, 0],
    ["application-unhealthy", "web", { Health: "unhealthy" }, migrationConfig, 0],
    ["application-starting", "web", { Health: "starting" }, migrationConfig, 0],
    ["migration-not-a-completion-dependency", "migrate", {}, {
      services: { web: { depends_on: { migrate: { condition: "service_started" } } }, migrate: {} },
    }, 0],
    ["migration-config-unavailable", "migrate", {}, migrationConfig, 1],
  ] as const) {
    const dir = fixture(name);
    const states = healthyStack.map((row) => row.Service === service ? { ...row, ...changes } : row);
    healthScenarios.set(dir, { config, states, configCode });
    const state = await startDeploy(dir, { healthTimeoutSec: 1 }).promise;
    assert.equal(state.status, "failed", `${name}: ${JSON.stringify(state)}`);
    assert.match(state.error!, /health check timed out/);
    assert.equal(state.steps.find((step) => step.label.startsWith("Health check"))?.status, "failed");
    passed++; console.log(`PASS ${name}: deployment health still fails`);
  }
  const rollbackDir = fixture("rollback");
  git(rollbackDir, "init", "-b", "main");
  git(rollbackDir, "config", "user.name", "Test"); git(rollbackDir, "config", "user.email", "test@example.invalid");
  git(rollbackDir, "add", "."); git(rollbackDir, "commit", "-m", "old");
  const before = git(rollbackDir, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(rollbackDir, ".env"), "TOKEN=remote-value\n");
  git(rollbackDir, "add", "."); git(rollbackDir, "commit", "-m", "new");
  const remote = path.join(temporary, "origin.git"); git(temporary, "clone", "--bare", rollbackDir, remote);
  git(rollbackDir, "remote", "add", "origin", remote); git(rollbackDir, "reset", "--hard", before);
  fs.writeFileSync(path.join(rollbackDir, ".env"), "TOKEN=operator-value\n");
  const rolledBack = await startDeploy(rollbackDir, { autoRollback: true }).promise;
  assert.equal(rolledBack.status, "rolled_back"); assert.equal(rolledBack.steps.at(-1)?.status, "ok");
  assert.equal(git(rollbackDir, "rev-parse", "HEAD"), before);
  assert.equal(fs.readFileSync(path.join(rollbackDir, ".env"), "utf8"), "TOKEN=operator-value\n");
  passed++; console.log("PASS failed build restores the old commit and environment after git reset");

  const abortDir = fixture("abort"); const aborted = startDeploy(abortDir, { autoRollback: true });
  assert.equal(abortDeploy(aborted.id), true);
  const abortedState = await aborted.promise;
  assert.equal(abortedState.status, "aborted");
  assert.equal(abortedState.steps.at(-1)?.label, "Restore previous version after abort");
  assert.equal(abortedState.steps.at(-1)?.status, "ok");
  assert.equal(calls.filter((call: { cwd: string; args: string[] }) => call.cwd === abortDir && call.args.includes("up")).length, 1);
  passed++; console.log("PASS cooperative abort stops the pipeline and restores the previous stack");

  let liveChunk = false;
  const listener = (state: { steps: { output: string; status: string }[] }) => {
    if (state.steps.some((step) => step.status === "running" && step.output.includes("first live chunk"))) liveChunk = true;
  };
  deployEvents.on("update", listener);
  const large = await startDeploy(fixture("large")).promise;
  deployEvents.off("update", listener);
  assert.equal(liveChunk, true);
  const row = deployHistory().find((record) => record.id === large.id)!;
  assert.ok(Array.isArray(JSON.parse(row.log!)));
  assert.ok(row.log!.length < 600_000);
  assert.equal(getDeploy(large.id)?.status, "succeeded");
  passed++; console.log("PASS deploy streams live chunks and persists bounded valid JSON");
  console.log(`\n${passed} pipeline checks passed (Docker simulated; Git real)`);
} finally {
  closeDb(); fs.rmSync(temporary, { recursive: true, force: true });
}
