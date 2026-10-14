import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "vpm-operations-"));
const root = path.join(temporary, "root");
const secondRoot = path.join(temporary, "second");
fs.mkdirSync(root); fs.mkdirSync(secondRoot);
process.env.VPM_ROOTS = root;
process.env.VPM_DATA_DIR = path.join(temporary, "data");
const files = await import("../src/lib/files.ts");
const { resolveFile, toDisplayPath } = await import("../src/lib/safe-path.ts");
const { discoverProjects, getProject } = await import("../src/lib/projects.ts");
const { closeDb } = await import("../src/lib/db.ts");
const meta = { user: "test", ip: "local" };
let passed = 0;
function check(name: string, fn: () => void) { fn(); passed++; console.log(`PASS ${name}`); }
try {
  fs.mkdirSync(path.join(root, "app"));
  fs.writeFileSync(path.join(root, "app", "compose.yml"), "services:\n  api:\n    image: alpine\n  worker:\n    image: alpine\n  web:\n    image: nginx\n");
  fs.mkdirSync(path.join(root, "empty"));
  check("only project directories are discovered; every compose service is read", () => {
    const projects = discoverProjects(); assert.equal(projects.length, 1);
    assert.deepEqual(getProject("/app").services, ["api", "worker", "web"]);
  });
  check("writes preserve permissions, back up contents, and reject stale edits", () => {
    const target = path.join(root, "app", "run.sh");
    fs.writeFileSync(target, "original", { mode: 0o700 });
    const mode = fs.statSync(target).mode;
    const result = files.writeFileSafe("/app/run.sh", "updated", meta, fs.statSync(target).mtimeMs);
    assert.equal(fs.statSync(target).mode, mode);
    assert.equal(fs.readFileSync(resolveFile(result.backupPath!), "utf8"), "original");
    assert.throws(() => files.writeFileSafe("/app/run.sh", "lost update", meta, result.mtimeMs - 1), /changed on disk/);
    assert.equal(fs.readFileSync(target, "utf8"), "updated");
  });
  check("configured roots cannot be removed or renamed", () => {
    assert.throws(() => files.deleteEntry("/", meta), /configured root/);
    assert.throws(() => files.renameEntry("/", "newroot", meta), /configured root/);
    assert.ok(fs.existsSync(root));
  });
  check("case-only folder rename preserves files and rejects an occupied destination", () => {
    fs.mkdirSync(path.join(root, "Workspace"));
    fs.writeFileSync(path.join(root, "Workspace", "keep.txt"), "preserved");
    const renamed = files.renameEntry("/Workspace", "workspace", meta);
    assert.equal(renamed.path, "/workspace");
    assert.ok(fs.readdirSync(root).includes("workspace"));
    assert.equal(fs.readFileSync(path.join(root, "workspace", "keep.txt"), "utf8"), "preserved");
    assert.equal(files.renameEntry("/workspace", "workspace", meta).path, "/workspace");
    assert.throws(() => files.renameEntry("/workspace", "app", meta), /already exists/);
    assert.ok(fs.existsSync(path.join(root, "workspace", "keep.txt")));
  });
  check("secret files, short passwords and backups are hidden from search and reads", () => {
    fs.writeFileSync(path.join(root, "app", "server.pem"), "PRIVATE-KEY-test-value");
    fs.writeFileSync(path.join(root, "app", "credentials.json"), '{"password":"search-secret"}');
    fs.writeFileSync(path.join(root, "app", ".env"), "PASSWORD=short\nTOKEN=search-secret\n");
    const hidden = files.readFileSafe("/app/server.pem");
    assert.equal(hidden.redacted, true); assert.ok(!hidden.content.includes("PRIVATE-KEY"));
    assert.throws(() => files.writeFileSafe("/app/server.pem", hidden.content, meta), /masked/);
    assert.ok(!files.readFileSafe("/app/.env").content.includes("short"));
    const backup = files.writeFileSafe("/app/.env", "TOKEN=new-value\n", meta).backupPath!;
    assert.equal(files.readFileSafe(backup).redacted, true);
    assert.deepEqual(files.searchFiles("search-secret", { content: true }), []);
    assert.equal(files.isEditable(".env.production"), true);
  });
  check("multiple roots give unambiguous paths and can both be edited", () => {
    process.env.VPM_ROOTS = [root, secondRoot].join(path.delimiter);
    fs.mkdirSync(path.join(secondRoot, "app"));
    fs.writeFileSync(path.join(secondRoot, "app", "run.sh"), "second");
    const first = toDisplayPath(path.join(root, "app", "run.sh"));
    const second = toDisplayPath(path.join(secondRoot, "app", "run.sh"));
    assert.notEqual(first, second);
    assert.equal(fs.readFileSync(resolveFile(second), "utf8"), "second");
    assert.equal(fs.readFileSync(resolveFile(first), "utf8"), "updated");
  });
  console.log(`\n${passed} operation checks passed`);
} finally {
  closeDb(); fs.rmSync(temporary, { recursive: true, force: true });
}
