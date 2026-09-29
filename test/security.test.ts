/**
 * Security tests for the path-confinement layer.
 *
 * These are the tests that matter: the file API is a remote shell over your
 * /opt, and every one of these cases is a way an attacker would try to escape.
 *
 * Run: node --experimental-strip-types test/security.test.ts
 *   (or via `npm test`)
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Point the roots at a throwaway sandbox before importing safe-path.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "vpm-sec-"));
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), "vpm-out-"));
process.env.VPM_ROOTS = SANDBOX;

fs.mkdirSync(path.join(SANDBOX, "app"), { recursive: true });
fs.writeFileSync(path.join(SANDBOX, "app", "index.ts"), "export const a = 1;\n");
fs.writeFileSync(path.join(SANDBOX, "app", ".env"), "SECRET_TOKEN=supersecretvalue123\n");
fs.writeFileSync(path.join(OUTSIDE, "secret.txt"), "do not read me\n");

// A symlink inside the sandbox pointing outside it.
const symlinkPath = path.join(SANDBOX, "escape");
try {
  fs.symlinkSync(OUTSIDE, symlinkPath, "junction");
} catch {
  // Symlinks may require elevation on Windows; those cases are skipped below.
}

const { resolveSafe, resolveFile, listDir, PathError, toDisplayPath } = await import(
  "../src/lib/safe-path.ts"
);
const { redactContent, isSecretFile, isEditable } = await import("../src/lib/files.ts");

let passed = 0;
let failed = 0;
let skipped = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } catch (err) {
    if (err instanceof Error && err.message.includes("SKIP:")) {
      skipped++;
      console.log(`  \x1b[33mSKIP\x1b[0m ${name} — ${err.message}`);
      return;
    }
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}`);
    console.log(`       ${(err as Error).message}`);
  }
}

function expectDenied(fn: () => unknown, label: string): void {
  try {
    const r = fn();
    throw new Error(`${label}: expected a PathError but got ${JSON.stringify(r)}`);
  } catch (err) {
    if (!(err instanceof PathError)) throw err;
    // Any of these means "refused, nothing was served": 400 malformed input,
    // 403 outside the boundary, 404 not found.
    if (![400, 403, 404].includes(err.status)) {
      throw new Error(`${label}: unexpected status ${err.status}`);
    }
  }
}

console.log("\nPath traversal");
test("rejects ../ traversal", () => {
  expectDenied(() => resolveSafe("../../etc/passwd", SANDBOX), "../");
  expectDenied(() => resolveSafe("../" + path.basename(OUTSIDE) + "/secret.txt", SANDBOX), "../nested");
});

test("rejects absolute paths outside the root", () => {
  expectDenied(() => resolveSafe(path.join(OUTSIDE, "secret.txt"), SANDBOX), "absolute outside");
  expectDenied(() => resolveSafe("/etc/passwd", SANDBOX), "/etc/passwd");
  if (process.platform === "win32") {
    expectDenied(() => resolveSafe("C:\\Windows\\System32\\drivers\\etc\\hosts", SANDBOX), "windows sys");
  }
});

test("rejects NUL byte injection", () => {
  expectDenied(() => resolveSafe("app/index.ts\0.txt", SANDBOX), "NUL");
  expectDenied(() => resolveSafe("\0", SANDBOX), "bare NUL");
});

test("rejects a symlink that escapes the root", () => {
  if (!fs.existsSync(symlinkPath)) throw new Error("SKIP: symlink creation not permitted");
  // Listing works (we flag it), but reading through it must be refused.
  expectDenied(() => resolveFile(path.join(symlinkPath, "secret.txt"), SANDBOX), "symlink read");
});

test("rejects a sibling directory with the root as a name prefix", () => {
  // /tmp/vpm-sec-XXX vs /tmp/vpm-sec-XXX-evil - a prefix match must not pass.
  const evil = `${SANDBOX}-evil`;
  fs.mkdirSync(evil, { recursive: true });
  fs.writeFileSync(path.join(evil, "x.txt"), "nope");
  try {
    expectDenied(() => resolveFile(path.join(evil, "x.txt"), SANDBOX), "prefix sibling");
  } finally {
    fs.rmSync(evil, { recursive: true, force: true });
  }
});

test("rejects traversal through an allowed-looking subpath", () => {
  expectDenied(() => resolveSafe("app/../../outside", SANDBOX), "subpath escape");
  expectDenied(() => resolveSafe("app/./../../etc", SANDBOX), "dot-slash escape");
});

console.log("\nLegitimate access still works");
test("reads a file inside the root", () => {
  const p = resolveFile(path.join(SANDBOX, "app", "index.ts"), SANDBOX);
  assert.ok(fs.readFileSync(p, "utf8").includes("export const a"));
});

test("resolves a relative display path to the root", () => {
  const p = resolveFile("/app/index.ts");
  assert.equal(path.basename(p), "index.ts");
  assert.equal(toDisplayPath(p), "/app/index.ts");
});

test("lists a directory and flags escaping symlinks", () => {
  const entries = listDir(SANDBOX);
  const names = entries.map((e) => e.name);
  assert.ok(names.includes("app"), "app dir listed");
  const escape = entries.find((e) => e.name === "escape");
  if (escape) assert.equal(escape.escaping, true, "escaping symlink flagged");
});

console.log("\nSecret redaction");
test("detects .env and key files as secret", () => {
  assert.equal(isSecretFile(".env"), true);
  assert.equal(isSecretFile(".env.production"), true);
  assert.equal(isSecretFile("id_rsa"), true);
  assert.equal(isSecretFile("server.pem"), true);
  assert.equal(isSecretFile("index.ts"), false);
  assert.equal(isSecretFile("app.tsx"), false);
});

test("masks secret values but keeps keys readable", () => {
  const input = "DATABASE_URL=postgres://u:p4ssw0rd@host/db\nAPI_KEY=abcdef123456\n# comment\nSHORT=x\n";
  const { text, redacted } = redactContent(input);
  assert.equal(redacted, true);
  assert.ok(text.includes("DATABASE_URL="), "key preserved");
  assert.ok(!text.includes("p4ssw0rd"), "password masked");
  assert.ok(!text.includes("abcdef123456"), "api key masked");
  assert.ok(text.includes("# comment"), "comments preserved");
  assert.ok(text.includes("SHORT=x"), "short values left alone");
});

test("keeps localhost dev URLs visible", () => {
  const { text } = redactContent("API_URL=http://localhost:3000\n");
  assert.ok(text.includes("localhost:3000"), "non-secret localhost url preserved");
});

console.log("\nEditability classification");
test("classifies source and config as editable", () => {
  for (const f of ["index.ts", "app.tsx", "main.py", "config.yaml", "Dockerfile", "nginx.conf"]) {
    assert.equal(isEditable(f), true, `${f} editable`);
  }
});

test("classifies binaries as not editable", () => {
  for (const f of ["image.png", "archive.zip", "font.woff2", "binary.so"]) {
    assert.equal(isEditable(f), false, `${f} not editable`);
  }
});

console.log("\nCleanup");
for (const dir of [SANDBOX, OUTSIDE]) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`);
process.exit(failed > 0 ? 1 : 0);
