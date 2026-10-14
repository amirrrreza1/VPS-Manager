import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "vpm-transfers-"));
const projects = path.join(temporary, "projects");
fs.mkdirSync(projects);
process.env.VPM_ROOTS = projects;
process.env.VPM_DATA_DIR = path.join(temporary, "data");
process.env.VPM_FILES_DIR = path.join(temporary, "personal");
process.env.VPM_MAX_UPLOAD_BYTES = "1024";
const { db, closeDb } = await import("../src/lib/db.ts");
const files = await import("../src/lib/files.ts");
const { resolveFile, toDisplayPath } = await import("../src/lib/safe-path.ts");
const { uploadStream, openDownload, downloadResponse, fileResponse } = await import("../src/lib/transfers.ts");
const { detectMedia } = await import("../src/lib/media.ts");
const { createShare, claimShare, listShares, revokeShare } = await import("../src/lib/shares.ts");
const meta = { user: "owner", ip: "local" };
const owner = { id: 1, username: "owner" };
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log(`PASS ${name}`); }
function body(...chunks: Uint8Array[]) { return new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }); }
function token(link: { downloadPath: string }) { return link.downloadPath.split("/")[3]; }
try {
  files.ensurePersonalStorage();
  db().prepare("INSERT INTO users (id, username, password_hash, password_salt, created_at) VALUES (1, 'owner', 'unused', 'unused', ?)").run(Date.now());
  await check("personal namespace is isolated and storage roots cannot be mutated", () => {
    assert.equal(files.listDirectory("/@personal").parent, null);
    assert.throws(() => resolveFile("/@personal/../projects"));
    assert.throws(() => files.deleteEntry("/@personal", meta), /configured root/);
    assert.throws(() => files.renameEntry("/@personal", "renamed", meta), /configured root/);
    assert.equal(toDisplayPath(projects), "/");
  });
  await check("streaming preserves binary bytes and refuses traversal and existing names", async () => {
    const bytes = Buffer.from([0, 255, 34, 10, 127]);
    const result = await uploadStream("/@personal", "photo ü.bin", body(bytes), meta, undefined, bytes.length);
    assert.equal(result.path, "/@personal/photo ü.bin");
    assert.deepEqual(fs.readFileSync(resolveFile(result.path)), bytes);
    await assert.rejects(uploadStream("/@personal", "../escape", body(bytes), meta), /separators/);
    await assert.rejects(uploadStream("/@personal", "photo ü.bin", body(Buffer.from("replace")), meta), /already exists/);
    assert.deepEqual(fs.readFileSync(resolveFile(result.path)), bytes);
  });
  await check("streamed size limits, truncated uploads and cancellation leave no partial files", async () => {
    await assert.rejects(uploadStream("/@personal", "too-big.bin", body(new Uint8Array(512), new Uint8Array(513)), meta), /too large/);
    await assert.rejects(uploadStream("/@personal", "truncated.bin", body(new Uint8Array(4)), meta, undefined, 8), /incomplete/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(uploadStream("/@personal", "aborted.bin", body(new Uint8Array(100)), meta, controller.signal));
    assert.deepEqual(fs.readdirSync(process.env.VPM_FILES_DIR!), ["photo ü.bin"]);
  });
  await check("downloads are unrestricted by edit/upload limits and forced to attachments", async () => {
    const data = Buffer.alloc(8192, 213);
    fs.writeFileSync(path.join(process.env.VPM_FILES_DIR!, "large.html"), data);
    const response = downloadResponse(openDownload("/@personal/large.html"));
    assert.equal(response.headers.get("Content-Type"), "application/octet-stream");
    assert.ok(response.headers.get("Content-Disposition")?.startsWith("attachment;"));
    assert.ok(response.headers.get("Cache-Control")?.includes("no-store"));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), data);
    assert.throws(() => openDownload("/@personal"), /regular file/);
  });
  await check("share tokens are hashed, bound to one file and never returned by listings", async () => {
    const link = createShare("/@personal/photo ü.bin", 60_000, false, owner, meta.ip);
    const row = db().prepare("SELECT * FROM file_shares WHERE id = ?").get(link.id);
    assert.ok(!JSON.stringify(row).includes(token(link)));
    assert.ok(!JSON.stringify(listShares(null, owner)).includes(token(link)));
    assert.deepEqual(Buffer.from(await downloadResponse(claimShare(token(link), meta.ip)).arrayBuffer()), Buffer.from([0, 255, 34, 10, 127]));
    assert.throws(() => claimShare("invalid", meta.ip), /unavailable/);
    revokeShare(link.id, owner, meta.ip);
    assert.throws(() => claimShare(token(link), meta.ip), /unavailable/);
  });
  await check("expiry and one-time limits cannot be bypassed by repeated requests", async () => {
    const expired = createShare("/@personal/photo ü.bin", 60_000, false, owner, meta.ip);
    db().prepare("UPDATE file_shares SET expires_at = ? WHERE id = ?").run(Date.now() - 1, expired.id);
    assert.throws(() => claimShare(token(expired), meta.ip), /unavailable/);
    const once = createShare("/@personal/photo ü.bin", 60_000, true, owner, meta.ip);
    const accepted = claimShare(token(once), meta.ip);
    assert.throws(() => claimShare(token(once), meta.ip), /unavailable/);
    await downloadResponse(accepted).arrayBuffer();
    assert.throws(() => createShare("/@personal/photo ü.bin", 8 * 24 * 60 * 60 * 1000, false, owner, meta.ip), /expiry/);
  });
  await check("replacement, edits, project files and secrets cannot leak through sharing", () => {
    fs.writeFileSync(path.join(projects, "private.txt"), "project");
    fs.writeFileSync(path.join(process.env.VPM_FILES_DIR!, ".env"), "TOKEN=private");
    assert.throws(() => createShare("/private.txt", 60_000, false, owner, meta.ip), /Personal files/);
    assert.throws(() => createShare("/@personal/.env", 60_000, false, owner, meta.ip), /credential/);
    const edited = createShare("/@personal/photo ü.bin", 60_000, false, owner, meta.ip);
    fs.writeFileSync(resolveFile("/@personal/photo ü.bin"), "changed");
    assert.throws(() => claimShare(token(edited), meta.ip), /unavailable/);
    const replacement = createShare("/@personal/photo ü.bin", 60_000, false, owner, meta.ip);
    fs.unlinkSync(resolveFile("/@personal/photo ü.bin"));
    fs.writeFileSync(path.join(process.env.VPM_FILES_DIR!, "photo ü.bin"), "replacement");
    assert.throws(() => claimShare(token(replacement), meta.ip), /unavailable/);
  });
  await check("personal symlinks cannot expose project files or outside directories", () => {
    const link = path.join(process.env.VPM_FILES_DIR!, "escape");
    fs.symlinkSync(projects, link, "junction");
    assert.throws(() => resolveFile("/@personal/escape/private.txt"));
    assert.throws(() => createShare("/@personal/escape/private.txt", 60_000, false, owner, meta.ip));
    assert.equal(files.listDirectory("/@personal").entries.find((entry) => entry.name === "escape")?.escaping, true);
  });
  await check("media classification checks signatures and rejects renamed active content", () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1kAAAAASUVORK5CYII=", "base64");
    fs.writeFileSync(path.join(process.env.VPM_FILES_DIR!, "picture.png"), png);
    assert.deepEqual(files.fileInfo("/@personal/picture.png").mediaPreview, { kind: "image", mimeType: "image/png" });
    for (const name of ["fake.png", "fake.mp4", "active.svg", "active.html"]) {
      fs.writeFileSync(path.join(process.env.VPM_FILES_DIR!, name), '<svg onload="alert(1)"></svg>');
      const file = openDownload(`/@personal/${name}`);
      try { assert.equal(detectMedia(file.fd, file.name), null); } finally { fs.closeSync(file.fd); }
      assert.equal(files.fileInfo(`/@personal/${name}`).mediaPreview, null);
    }
  });
  await check("video streaming serves precise ranges, suffixes, and open-ended requests", async () => {
    const movie = Buffer.alloc(8192);
    movie.writeUInt32BE(24); movie.write("ftypisom", 4);
    for (let i = 24; i < movie.length; i++) movie[i] = i % 256;
    fs.writeFileSync(path.join(process.env.VPM_FILES_DIR!, "movie.mp4"), movie);
    assert.equal(files.fileInfo("/@personal/movie.mp4").mediaPreview?.kind, "video");
    for (const [range, start, end] of [["bytes=24-49", 24, 49], ["bytes=8100-", 8100, 8191], ["bytes=-10", 8182, 8191], ["bytes=8190-9000", 8190, 8191], ["bytes=-99999", 0, 8191]] as const) {
      const response = fileResponse(openDownload("/@personal/movie.mp4"), { inline: true, mimeType: "video/mp4", range });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get("Content-Range"), `bytes ${start}-${end}/8192`);
      assert.equal(response.headers.get("Content-Length"), String(end - start + 1));
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), movie.subarray(start, end + 1));
      assert.equal(response.headers.get("Accept-Ranges"), "bytes");
      assert.equal(response.headers.get("Cross-Origin-Resource-Policy"), "same-origin");
      assert.ok(response.headers.get("Content-Disposition")?.startsWith("inline;"));
    }
  });
  await check("invalid ranges and HEAD close files without streaming or leaking extra bytes", async () => {
    for (const range of ["bytes=99999-", "bytes=-0", "bytes=20-10", "bytes=0-1,3-5", "bytes=", "bytes=-", "items=0-4", "bytes=9007199254740993-"]) {
      const file = openDownload("/@personal/movie.mp4");
      const response = fileResponse(file, { inline: true, mimeType: "video/mp4", range });
      assert.equal(response.status, 416);
      assert.equal(response.headers.get("Content-Range"), "bytes */8192");
      assert.equal((await response.arrayBuffer()).byteLength, 0);
      assert.throws(() => fs.fstatSync(file.fd));
    }
    const file = openDownload("/@personal/movie.mp4");
    const head = fileResponse(file, { inline: true, mimeType: "video/mp4", head: true, range: "bytes=0-9" });
    assert.equal(head.status, 200); assert.equal(head.headers.get("Content-Length"), "8192");
    assert.equal((await head.arrayBuffer()).byteLength, 0); assert.throws(() => fs.fstatSync(file.fd));
    fs.writeFileSync(path.join(process.env.VPM_FILES_DIR!, "zero.bin"), "");
    assert.equal((await downloadResponse(openDownload("/@personal/zero.bin")).arrayBuffer()).byteLength, 0);
  });
  console.log(`\n${passed} transfer and share security checks passed`);
} finally { closeDb(); fs.rmSync(temporary, { recursive: true, force: true }); }
