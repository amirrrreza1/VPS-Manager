import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "vpm-automation-"));
const root = path.join(temporary, "root"); fs.mkdirSync(root);
process.env.VPM_ROOTS = root; process.env.VPM_DATA_DIR = path.join(temporary, "data");
const { provisionProject, validateRepository } = await import("../src/lib/provision.ts");
const { configureAutomation, automationTick, listAutomation } = await import("../src/lib/automation.ts");
const { controlStack } = await import("../src/lib/stack-control.ts");
const { lockProject } = await import("../src/lib/project-lock.ts");
const { backupDatabase, dailyDatabaseBackup } = await import("../src/lib/maintenance.ts");
const { closeDb, db, getSetting } = await import("../src/lib/db.ts");
const { deployHistory, getDeploy } = await import("../src/lib/deploy.ts");
// @ts-expect-error JavaScript test fixture.
const { calls, cloneSources } = await import("./fake-exec.mjs");
const meta = { user: "test", ip: "local" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const create = (name: string, template: "static" | "image" | "postgres" | "redis") => provisionProject({ name, root, template, ...(template === "image" ? { image: "nginx:stable-alpine" } : {}) }, meta);
let passed = 0;
function check(label: string, verify: () => void) { verify(); passed++; console.log(`PASS ${label}`); }

try {
  for (const template of ["static", "image", "postgres", "redis"] as const) {
    const info = await create(`new-${template}`, template);
    const compose = fs.readFileSync(path.join(info.absPath, "compose.yaml"), "utf8");
    check(`${template} provisions a discoverable private service`, () => { assert.ok(info.composeFile); assert.match(compose, /restart: unless-stopped/); assert.match(compose, /127\.0\.0\.1:/); });
  }
  const pgEnv = fs.readFileSync(path.join(root, "new-postgres", ".env"), "utf8");
  check("PostgreSQL generates a strong password and persistent storage", () => { assert.match(pgEnv, /POSTGRES_PASSWORD=[a-f0-9]{64}/); assert.match(fs.readFileSync(path.join(root, "new-postgres", "compose.yaml"), "utf8"), /database:\/var\/lib\/postgresql\/data/); });
  check("Redis generates a strong connection password", () => assert.match(fs.readFileSync(path.join(root, "new-redis", ".env"), "utf8"), /REDIS_PASSWORD=[a-f0-9]{64}/));
  await assert.rejects(create("new-static", "static"), /already exists/);
  await assert.rejects(create("../escape", "static"), /name must/);
  await assert.rejects(provisionProject({ name: "escape", root: temporary, template: "static" }, meta), /configured project root/);
  check("provisioning refuses collisions, traversal, credentials and unsafe transports", () => {
    for (const url of ["file:///tmp/repo", "ext::evil", "https://user:token@example.com/repo", "-u", "http://example.com/repo"]) assert.throws(() => validateRepository(url));
    assert.equal(validateRepository("git@github.com:owner/repo.git"), "git@github.com:owner/repo.git");
  });

  const seed = path.join(temporary, "seed"); fs.mkdirSync(seed);
  git(seed, "init", "-b", "main"); git(seed, "config", "user.name", "Test"); git(seed, "config", "user.email", "test@example.invalid");
  fs.writeFileSync(path.join(seed, "package.json"), JSON.stringify({ scripts: { start: "node index.js" } }));
  fs.writeFileSync(path.join(seed, "package-lock.json"), "{}"); fs.writeFileSync(path.join(seed, "index.js"), "console.log('v1')");
  git(seed, "add", "."); git(seed, "commit", "-m", "initial");
  const remote = path.join(temporary, "origin.git"); git(temporary, "clone", "--bare", seed, remote);
  cloneSources.set("https://example.invalid/app.git", remote);
  const imported = await provisionProject({ name: "imported", root, template: "repository", repository: "https://example.invalid/app.git" }, meta);
  check("Git import generates npm Docker scaffolding without dirtying the repo", () => { assert.equal(imported.dirty, false); assert.equal(imported.branch, "main"); assert.ok(imported.composeFile); assert.ok(fs.existsSync(path.join(imported.absPath, "Dockerfile"))); });
  configureAutomation(imported.absPath, true, 60, meta);
  await automationTick();
  check("unchanged Git origin does not trigger a deploy", () => assert.equal(deployHistory().length, 0));
  git(seed, "remote", "add", "origin", remote);
  fs.writeFileSync(path.join(seed, "index.js"), "console.log('v2')"); git(seed, "add", "."); git(seed, "commit", "-m", "update"); git(seed, "push", "origin", "main");
  await automationTick(Date.now() + 61_000);
  check("new origin commit automatically deploys with health checks", () => { const record = deployHistory()[0]; assert.equal(record.status, "succeeded"); assert.equal(git(imported.absPath, "rev-parse", "HEAD"), git(seed, "rev-parse", "HEAD")); assert.ok(getDeploy(record.id)?.steps.some((step) => step.label.startsWith("Health check"))); });

  fs.writeFileSync(path.join(imported.absPath, "index.js"), "operator changes");
  const count = deployHistory().length;
  await automationTick(Date.now() + 122_000);
  check("automatic deployment preserves uncommitted server changes", () => { assert.equal(deployHistory().length, count); assert.match(listAutomation()[0].error!, /uncommitted/); });
  git(imported.absPath, "checkout", "--", "index.js");
  const release = lockProject(imported.absPath, "test lock");
  await assert.rejects(controlStack(imported.absPath, "restart", meta), /project busy/); release();
  await controlStack(imported.absPath, "stop", meta);
  check("stop pauses automation and preserves volumes", () => { assert.equal(listAutomation()[0].enabled, 0); assert.equal(calls.some((call: { args: string[] }) => call.args.includes("--volumes") || call.args.includes("down")), false); });
  await controlStack(imported.absPath, "start", meta);
  check("start does not silently reenable automatic deployment", () => assert.equal(listAutomation()[0].enabled, 0));
  await assert.rejects(controlStack(imported.absPath, "exec" as "start", meta), /unsupported/);

  // A failed commit is attempted only once, including after the DB reopens.
  fs.renameSync(imported.absPath, path.join(root, "auto-build-fails"));
  const failed = path.join(root, "auto-build-fails");
  configureAutomation(failed, true, 60, meta);
  fs.writeFileSync(path.join(seed, "index.js"), "console.log('v3')"); git(seed, "add", "."); git(seed, "commit", "-m", "broken candidate"); git(seed, "push", "origin", "main");
  await automationTick(Date.now() + 183_000);
  const attempted = deployHistory().length;
  closeDb();
  await automationTick(Date.now() + 244_000);
  check("failed commits roll back and are not retried after restart", () => { assert.equal(deployHistory().length, attempted); assert.ok(listAutomation().find((rule) => rule.path === failed)?.error?.includes("already attempted")); });

  const backup = backupDatabase(meta);
  const snapshot = new DatabaseSync(path.join(temporary, "data", "backups", backup), { readOnly: true });
  check("online database backup includes current WAL data", () => { assert.ok((snapshot.prepare("SELECT count(*) AS n FROM deploys").get() as { n: number }).n > 0); assert.ok(getSetting("backup.last_at")); });
  snapshot.close();
  const before = fs.readdirSync(path.join(temporary, "data", "backups")).length;
  dailyDatabaseBackup();
  assert.equal(fs.readdirSync(path.join(temporary, "data", "backups")).length, before);
  for (let i = 0; i < 9; i++) backupDatabase(meta);
  check("backup scheduler skips recent snapshots and retention keeps seven", () => { assert.equal(fs.readdirSync(path.join(temporary, "data", "backups")).length, 7); assert.ok(db()); });
  console.log(`\n${passed} automation and provisioning checks passed`);
} finally { closeDb(); fs.rmSync(temporary, { recursive: true, force: true }); }
