/**
 * End-to-end smoke test against a running server.
 *   node test/e2e.mjs [baseUrl]
 *
 * Exercises the real HTTP surface: setup, login, session cookie, directory
 * listing, file read, secret redaction, write, and traversal defence.
 */

const BASE = process.argv[2] ?? "http://localhost:3999";
import { authenticator } from "otplib";

let pass = 0;
let fail = 0;
const jar = new Map();

function ok(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${extra}`);
  }
}

async function call(pathname, options = {}) {
  const headers = { Origin: BASE, ...(options.headers ?? {}) };
  if (jar.size > 0) {
    headers.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  if (options.json) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.json);
  }
  const res = await fetch(`${BASE}${pathname}`, { ...options, headers, redirect: "manual" });
  const setCookies = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookies) {
    const [pair] = c.split(";");
    const idx = pair.indexOf("=");
    const name = pair.slice(0, idx);
    const value = pair.slice(idx + 1);
    if (value === "" || /Max-Age=0/i.test(c)) jar.delete(name);
    else jar.set(name, value);
  }
  return res;
}

const USERNAME = "smoke";
const PASSWORD = "smoke-test-password-123";

console.log(`\nSmoke test against ${BASE}\n`);

console.log("Unauthenticated access");
{
  const res = await call("/api/projects");
  ok("API rejects unauthenticated request", res.status === 401, `got ${res.status}`);
  const page = await call("/dashboard");
  ok("dashboard redirects to login when signed out", page.status === 307 || page.status === 302,
     `got ${page.status}`);
  ok("server telemetry requires authentication", (await call("/api/server")).status === 401);
  const serverPage = await call("/server");
  ok("server page requires authentication", serverPage.status === 307 || serverPage.status === 302);
}

console.log("\nSetup");
{
  const res = await call("/api/setup", {
    method: "POST",
    json: { username: USERNAME, password: PASSWORD },
  });
  const body = await res.json().catch(() => ({}));
  // 409 means a previous run created it; that is still a valid end state.
  ok("setup creates the account (or already exists)", res.status === 200 || res.status === 409,
     `got ${res.status} ${JSON.stringify(body)}`);

  const weak = await call("/api/setup", {
    method: "POST",
    json: { username: "another", password: "short" },
  });
  ok("setup rejects a short password", weak.status === 400 || weak.status === 409,
     `got ${weak.status}`);
}

console.log("\nLogin");
{
  const bad = await call("/api/auth/login", {
    method: "POST",
    json: { phase: "password", username: USERNAME, password: "wrong-password-entirely" },
  });
  ok("wrong password is rejected", bad.status === 401, `got ${bad.status}`);

  const res = await call("/api/auth/login", {
    method: "POST",
    json: { phase: "password", username: USERNAME, password: PASSWORD },
  });
  const body = await res.json().catch(() => ({}));
  ok("correct password logs in", res.status === 200 && body.ok === true, `got ${res.status}`);
  ok("session cookie was issued", jar.has("vpm_session"));
  const dashboard = await call("/dashboard");
  ok("dashboard loads after account creation and login", dashboard.status === 200,
     `got ${dashboard.status}, redirect ${dashboard.headers.get("location")}`);
}

console.log("\nProject discovery");
let projects = [];
{
  const res = await call("/api/projects");
  const body = await res.json();
  ok("projects endpoint responds", res.status === 200, `got ${res.status}`);
  ok("capabilities reported", typeof body.capabilities?.host === "string");
  // Regression: hasDockerCompose() once passed process.cwd() (outside the
  // allowed roots) into a path-validating helper, so it always reported false
  // and the UI showed a bogus "compose is not usable" warning.
  if (body.capabilities?.docker) {
    ok(
      "docker compose reported usable when docker exists",
      body.capabilities?.dockerCompose === true,
      JSON.stringify(body.capabilities),
    );
  }
  projects = body.projects ?? [];
  ok("seeded demo project discovered", projects.some((p) => p.name === "demo-api"),
     JSON.stringify(projects.map((p) => p.name)));
  const demo = projects.find((p) => p.name === "demo-api");
  ok("compose file detected", demo?.composeFile === "docker-compose.yml", String(demo?.composeFile));
  ok("env keys listed without values", demo?.envKeys?.includes("DATABASE_URL") === true,
     JSON.stringify(demo?.envKeys));
}

console.log("\nServer telemetry");
{
  const response = await call("/api/server");
  const server = await response.json();
  ok("authenticated server inspection succeeds", response.status === 200);
  ok("server information is not cached publicly", response.headers.get("cache-control")?.includes("no-store"));
  ok("server identifies its monitoring scope", ["native", "host", "container"].includes(server.source));
  ok("real CPU and memory capacity are reported", server.cpu?.logicalCores > 0 && server.memory?.total > 0);
  ok("memory usage is a valid percentage", server.memory?.percent >= 0 && server.memory.percent <= 100);
  ok("storage, networks, processes, and services have bounded results", Array.isArray(server.storage) && Array.isArray(server.network) && server.processes?.entries?.length <= 15 && server.services?.entries?.length <= 1000);
  ok("server clock and panel runtime are present", typeof server.identity?.serverTime === "string" && server.runtime?.node?.startsWith("v"));
  ok("process inspection exposes no command lines", server.processes?.entries?.every((entry) => !Object.hasOwn(entry, "command") && !Object.hasOwn(entry, "cmdline") && !Object.hasOwn(entry, "env")));
  ok("server details page loads", (await call("/server")).status === 200);
}

console.log("\nFile browsing");
{
  const res = await call("/api/files?path=/");
  const body = await res.json();
  ok("root directory lists", res.status === 200 && Array.isArray(body.entries), `got ${res.status}`);
  ok("demo-api visible at root", body.entries?.some((e) => e.name === "demo-api"));
}

console.log("\nReading a source file");
{
  const res = await call("/api/files?action=read&path=/demo-api/index.ts");
  const body = await res.json();
  ok("reads a .ts file", res.status === 200 && body.content?.includes("export async function main"),
     `got ${res.status}`);
  ok("marked editable", body.editable === true);
}

console.log("\nSecret redaction");
{
  const res = await call("/api/files?action=read&path=/demo-api/.env");
  const body = await res.json();
  ok("reads .env", res.status === 200, `got ${res.status}`);
  ok("flags the file as redacted", body.redacted === true, JSON.stringify(body).slice(0, 200));
  const envText = typeof body.content === "string" ? body.content : "";
  ok("hides the secret value", !envText.includes("changeme"), envText);
  ok("keeps the key name visible", envText.includes("DATABASE_URL"));

  const revealed = await call("/api/files?action=read&path=/demo-api/.env&reveal=1");
  const rbody = await revealed.json();
  ok("reveal returns the real value", rbody.content?.includes("changeme") === true);

  // Writing back masked text would replace real secrets with asterisks.
  const attempt = await call("/api/files/mutate", {
    method: "POST",
    json: { op: "write", path: "/demo-api/.env", content: envText },
  });
  ok("server refuses to write masked secrets", attempt.status === 400, `got ${attempt.status}`);

  const intact = await (await call("/api/files?action=read&path=/demo-api/.env&reveal=1")).json();
  ok(".env on disk was not corrupted", intact.content?.includes("changeme") === true);
}

console.log("\nWriting a file");
{
  const target = `/demo-api/index.ts`;
  const before = await (await call(`/api/files?action=read&path=${encodeURIComponent(target)}`)).json();
  const next = before.content + "\n// smoke test edit\n";

  const res = await call("/api/files/mutate", {
    method: "POST",
    json: { op: "write", path: target, content: next },
  });
  const body = await res.json();
  ok("write succeeds", res.status === 200 && body.ok === true, `got ${res.status} ${JSON.stringify(body)}`);
  ok("reports a backup file", typeof body.backupPath === "string");

  const after = await (await call(`/api/files?action=read&path=${encodeURIComponent(target)}`)).json();
  ok("content persisted", after.content.includes("smoke test edit"));
  ok("backup exists on disk", body.backupPath ? true : false);
}

console.log("\nPath traversal defence (live)");
for (const evil of [
  "/../../../../etc/passwd",
  "/demo-api/../../../../etc/passwd",
  "/..%2f..%2fetc/passwd",
  "C:/Windows/win.ini",
  "/demo-api/./../../../Windows/System32/drivers/etc/hosts",
]) {
  const res = await call(`/api/files?action=read&path=${encodeURIComponent(evil)}`);
  const body = await res.json().catch(() => ({}));
  const leaked = typeof body.content === "string" && body.content.length > 0;
  ok(`refuses ${evil}`, !leaked && res.status !== 200, `status ${res.status}`);
}

{
  const res = await call("/api/files?action=read&path=%00/etc/passwd");
  ok("refuses NUL byte in path", res.status !== 200, `status ${res.status}`);
}

console.log("\nSearch");
{
  const res = await call("/api/files/search?q=main&content=1");
  const body = await res.json();
  ok("search returns results", res.status === 200 && Array.isArray(body.results));
  ok("finds the demo file", body.results?.some((r) => r.name === "index.ts"),
     JSON.stringify(body.results?.map((r) => r.name)));
}

console.log("\nAudit trail");
{
  const res = await call("/api/audit?limit=20");
  const body = await res.json();
  ok("audit endpoint responds", res.status === 200);
  ok("records the file write", body.entries?.some((e) => e.action === "file.write"),
     JSON.stringify(body.entries?.map((e) => e.action)));
  ok("records the successful login", body.entries?.some((e) => e.action === "auth.login"));
  ok("records the failed login", body.entries?.some((e) => e.ok === 0));
}

console.log("\nSecurity headers");
{
  const res = await call("/login");
  ok("X-Frame-Options denied", res.headers.get("x-frame-options") === "DENY");
  ok("nosniff set", res.headers.get("x-content-type-options") === "nosniff");
  ok("CSP set", (res.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'none'"));

  // Regression: the proxy used to return a bare NextResponse.redirect() on the
  // auth-redirect paths, which silently dropped every security header.
  const redirect = await call("/login");
  ok(
    "redirect responses keep security headers",
    (redirect.status === 307 || redirect.status === 302) &&
      redirect.headers.get("x-frame-options") === "DENY" &&
      (redirect.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'none'"),
    `status ${redirect.status} xfo=${redirect.headers.get("x-frame-options")}`,
  );
}

console.log("\nLogout");
{
  const res = await call("/api/auth/logout", { method: "POST" });
  ok("logout succeeds", res.status === 200);
  const after = await call("/api/projects");
  ok("session invalidated after logout", after.status === 401, `got ${after.status}`);
}

console.log("\nAccount security and file operations");
{
  const login = async (password = PASSWORD) => call("/api/auth/login", { method: "POST", json: { username: USERNAME, password } });
  await login();
  ok("2FA status initially disabled", (await (await call("/api/auth/totp")).json()).hasTotp === false);
  const csrf = await call("/api/files/mutate", { method: "POST", headers: { Origin: "https://foreign.example" }, json: { op: "createFile", dir: "/demo-api", name: "csrf.txt" } });
  ok("cross-origin mutations rejected", csrf.status === 403);
  const prototypeOp = await call("/api/files/mutate", { method: "POST", json: { op: "toString" } });
  ok("inherited operation names rejected", prototypeOp.status === 400);
  const rootDelete = await call("/api/files/mutate", { method: "POST", json: { op: "delete", path: "/" } });
  ok("configured root deletion rejected", rootDelete.status === 400);
  const createDir = await call("/api/files/mutate", { method: "POST", json: { op: "createDir", dir: "/demo-api", name: "e2e-folder" } });
  ok("creates a folder", createDir.status === 200);
  const create = await call("/api/files/mutate", { method: "POST", json: { op: "createFile", dir: "/demo-api/e2e-folder", name: "notes.txt", content: "first" } });
  ok("creates a file", create.status === 200);
  const snapshot = await (await call("/api/files?action=read&path=/demo-api/e2e-folder/notes.txt")).json();
  const conflict = await call("/api/files/mutate", { method: "POST", json: { op: "write", path: snapshot.path, content: "stale", expectedMtimeMs: snapshot.mtimeMs - 1 } });
  ok("stale edits rejected", conflict.status === 409);
  const rename = await call("/api/files/mutate", { method: "POST", json: { op: "rename", path: snapshot.path, name: "renamed.txt" } });
  ok("renames a file", rename.status === 200);
  const form = new FormData(); form.set("dir", "/demo-api/e2e-folder"); form.set("file", new Blob(["uploaded"]), "upload.txt");
  const upload = await call("/api/files/mutate", { method: "POST", body: form });
  ok("multipart upload works", upload.status === 200);
  const duplicateForm = new FormData(); duplicateForm.set("dir", "/demo-api/e2e-folder"); duplicateForm.set("file", new Blob(["overwrite"]), "upload.txt");
  ok("upload refuses overwrites", (await call("/api/files/mutate", { method: "POST", body: duplicateForm })).status === 409);
  const download = await call("/api/files?action=download&path=/demo-api/e2e-folder/upload.txt");
  ok("download returns uploaded bytes", (await download.text()) === "uploaded");
  const largeForm = new FormData();
  largeForm.set("dir", "/demo-api/e2e-folder"); largeForm.set("file", new Blob([new Uint8Array(11 * 1024 * 1024)]), "large.bin");
  ok("uploads larger than Next's default proxy buffer succeed", (await call("/api/files/mutate", { method: "POST", body: largeForm })).status === 200);
  ok("removes a folder and its contents", (await call("/api/files/mutate", { method: "POST", json: { op: "delete", path: "/demo-api/e2e-folder" } })).status === 200);
  ok("empty directories excluded from discovery", !(await (await call("/api/projects")).json()).projects.some((p) => p.name === "empty"));
  ok("deploy rejects a directory without compose", (await call("/api/deploy", { method: "POST", json: { project: "/empty" } })).status === 400);

  console.log("\nPersonal files and public sharing");
  const personal = await (await call("/api/files?path=%2F%40personal")).json();
  ok("personal storage is separate and has no browsable parent", personal.path === "/@personal" && personal.parent === null);
  ok("locations include personal and project files", personal.locations?.length >= 2);
  ok("streamed upload rejects unauthenticated requests", (await fetch(`${BASE}/api/files/upload?dir=%2F%40personal&name=blocked.bin`, { method: "POST", body: "blocked" })).status === 401);
  ok("share management requires login", (await fetch(`${BASE}/api/files/shares`)).status === 401);
  ok("streamed upload rejects cross-origin requests", (await call("/api/files/upload?dir=%2F%40personal&name=blocked.bin", { method: "POST", headers: { Origin: "https://foreign.example" }, body: "blocked" })).status === 403);
  const binary = new Uint8Array(11 * 1024 * 1024).fill(213); binary[0] = 0; binary[binary.length - 1] = 127;
  const binaryPath = "/@personal/personal ü.bin";
  ok("large streaming upload succeeds", (await call(`/api/files/upload?dir=%2F%40personal&name=${encodeURIComponent("personal ü.bin")}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: binary })).status === 200);
  ok("empty streaming upload succeeds", (await call("/api/files/upload?dir=%2F%40personal&name=empty.txt", { method: "POST", body: "" })).status === 200);
  ok("streaming refuses to overwrite an existing file", (await call(`/api/files/upload?dir=%2F%40personal&name=${encodeURIComponent("personal ü.bin")}`, { method: "POST", body: "replacement" })).status === 409);
  const info = await (await call(`/api/files?action=info&path=${encodeURIComponent(binaryPath)}`)).json();
  ok("large binaries have downloadable metadata without loading the editor", info.size === binary.length && info.previewAvailable === false);
  const originalDownload = await call(`/api/files?action=download&path=${encodeURIComponent(binaryPath)}`);
  ok("large downloads preserve exact binary bytes", Buffer.from(await originalDownload.arrayBuffer()).equals(Buffer.from(binary)));
  ok("uploads cannot create traversal filenames", (await call("/api/files/upload?dir=%2F%40personal&name=..%2Fescape", { method: "POST", body: "escape" })).status === 400);
  const shared = await (await call("/api/files/shares", { method: "POST", json: { path: binaryPath, lifetimeMs: 3600000, oneTime: false } })).json();
  ok("creates an expiring download link", typeof shared.downloadPath === "string" && shared.expiresAt > Date.now());
  const publicDownload = await fetch(`${BASE}${shared.downloadPath}`);
  ok("share link works without login and returns exact bytes", publicDownload.status === 200 && Buffer.from(await publicDownload.arrayBuffer()).equals(Buffer.from(binary)));
  ok("shared downloads are attachments and never cached", publicDownload.headers.get("content-disposition")?.startsWith("attachment;") && publicDownload.headers.get("cache-control")?.includes("no-store"));
  ok("shared downloads are not indexed or sniffed", publicDownload.headers.get("x-robots-tag")?.includes("noindex") && publicDownload.headers.get("x-content-type-options") === "nosniff");
  const savedLinks = await (await call("/api/files/shares")).json();
  ok("saved links expose no bearer tokens", !JSON.stringify(savedLinks).includes(shared.downloadPath.split("/")[3]));
  ok("revokes a share link", (await call("/api/files/shares", { method: "DELETE", json: { id: shared.id } })).status === 200);
  ok("revoked download fails without exposing a file", (await fetch(`${BASE}${shared.downloadPath}`)).status === 404);
  const once = await (await call("/api/files/shares", { method: "POST", json: { path: binaryPath, lifetimeMs: 3600000, oneTime: true } })).json();
  ok("HEAD cannot consume a one-time link", (await fetch(`${BASE}${once.downloadPath}`, { method: "HEAD" })).status === 405);
  const raced = await Promise.all([fetch(`${BASE}${once.downloadPath}`), fetch(`${BASE}${once.downloadPath}`)]);
  ok("only one concurrent request can use a one-time link", raced.filter((response) => response.status === 200).length === 1 && raced.filter((response) => response.status === 404).length === 1);
  await Promise.all(raced.map((response) => response.arrayBuffer()));
  ok("project files cannot be shared", (await call("/api/files/shares", { method: "POST", json: { path: "/demo-api/index.ts", lifetimeMs: 3600000, oneTime: false } })).status === 403);
  await call("/api/files/upload?dir=%2F%40personal&name=.env", { method: "POST", body: "TOKEN=credential" });
  ok("credential files cannot be shared", (await call("/api/files/shares", { method: "POST", json: { path: "/@personal/.env", lifetimeMs: 3600000, oneTime: false } })).status === 403);
  ok("link expiry cannot be unbounded", (await call("/api/files/shares", { method: "POST", json: { path: binaryPath, lifetimeMs: 0, oneTime: false } })).status === 400);
  const changed = await (await call("/api/files/shares", { method: "POST", json: { path: "/@personal/empty.txt", lifetimeMs: 3600000, oneTime: false } })).json();
  await call("/api/files/mutate", { method: "POST", json: { op: "write", path: "/@personal/empty.txt", content: "new private content" } });
  ok("old links cannot expose newly edited content", (await fetch(`${BASE}${changed.downloadPath}`)).status === 404);
  ok("invalid tokens cannot be used as file paths", (await fetch(`${BASE}/api/shared/not-a-token/download?path=/demo-api/.env`)).status === 404);
  await call("/api/files/mutate", { method: "POST", json: { op: "delete", path: binaryPath } });
  await call("/api/files/mutate", { method: "POST", json: { op: "delete", path: "/@personal/empty.txt" } });
  await call("/api/files/mutate", { method: "POST", json: { op: "delete", path: "/@personal/.env" } });

  console.log("\nPrivate picture and video previews");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1kAAAAASUVORK5CYII=", "base64");
  await call("/api/files/upload?dir=%2F%40personal&name=preview.png", { method: "POST", body: png });
  const previewUrl = "/api/files/preview?path=%2F%40personal%2Fpreview.png";
  ok("picture previews require authentication", (await fetch(`${BASE}${previewUrl}`)).status === 401);
  const pictureInfo = await (await call("/api/files?action=info&path=%2F%40personal%2Fpreview.png")).json();
  ok("pictures advertise a media preview", pictureInfo.mediaPreview?.kind === "image" && pictureInfo.mediaPreview.mimeType === "image/png");
  const picture = await call(previewUrl);
  ok("picture preview returns original bytes and a safe image MIME type", picture.status === 200 && picture.headers.get("content-type") === "image/png" && Buffer.from(await picture.arrayBuffer()).equals(png));
  ok("previews remain private and block MIME sniffing", picture.headers.get("cache-control")?.includes("no-store") && picture.headers.get("x-content-type-options") === "nosniff" && picture.headers.get("cross-origin-resource-policy") === "same-origin");
  const movie = Buffer.alloc(16384, 201); movie.writeUInt32BE(24); movie.write("ftypisom", 4);
  await call("/api/files/upload?dir=%2F%40personal&name=preview.mp4", { method: "POST", body: movie });
  const movieInfo = await (await call("/api/files?action=info&path=%2F%40personal%2Fpreview.mp4")).json();
  ok("videos advertise a video preview", movieInfo.mediaPreview?.kind === "video");
  const movieUrl = "/api/files/preview?path=%2F%40personal%2Fpreview.mp4";
  const chunk = await call(movieUrl, { headers: { Range: "bytes=4096-8191" } });
  ok("video seeking returns only the requested bytes", chunk.status === 206 && chunk.headers.get("content-range") === "bytes 4096-8191/16384" && Buffer.from(await chunk.arrayBuffer()).equals(movie.subarray(4096, 8192)));
  const tail = await call(movieUrl, { headers: { Range: "bytes=-25" } });
  ok("video suffix ranges work", tail.status === 206 && Buffer.from(await tail.arrayBuffer()).equals(movie.subarray(-25)));
  const metadata = await call(movieUrl, { method: "HEAD" });
  ok("video HEAD returns size and range support without bytes", metadata.status === 200 && metadata.headers.get("content-length") === "16384" && metadata.headers.get("accept-ranges") === "bytes" && (await metadata.arrayBuffer()).byteLength === 0);
  const invalidRange = await call(movieUrl, { headers: { Range: "bytes=99999-" } });
  ok("unsatisfiable video ranges are rejected", invalidRange.status === 416 && invalidRange.headers.get("content-range") === "bytes */16384");
  await call("/api/files/upload?dir=%2F%40personal&name=fake-image.png", { method: "POST", body: '<html><script>alert(1)</script></html>' });
  ok("HTML disguised as a picture cannot be served inline", (await call("/api/files/preview?path=%2F%40personal%2Ffake-image.png")).status === 415);
  await call("/api/files/upload?dir=%2F%40personal&name=active.svg", { method: "POST", body: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>' });
  ok("active SVG files remain download-only", (await call("/api/files/preview?path=%2F%40personal%2Factive.svg")).status === 415);
  ok("preview endpoint confines filesystem paths", (await call("/api/files/preview?path=%2F%40personal%2F..%2F..%2Fetc%2Fpasswd")).status !== 200);
  const pictureShare = await (await call("/api/files/shares", { method: "POST", json: { path: "/@personal/preview.png", lifetimeMs: 3600000, oneTime: false } })).json();
  const sharedPicture = await fetch(`${BASE}${pictureShare.downloadPath}`);
  ok("public media share links remain forced downloads", sharedPicture.status === 200 && sharedPicture.headers.get("content-disposition")?.startsWith("attachment;") && sharedPicture.headers.get("content-type") === "application/octet-stream");
  await sharedPicture.arrayBuffer();
  for (const name of ["preview.png", "preview.mp4", "fake-image.png", "active.svg"]) await call("/api/files/mutate", { method: "POST", json: { op: "delete", path: `/@personal/${name}` } });

  const oldSession = jar.get("vpm_session");
  const setup = await (await call("/api/auth/totp", { method: "POST", json: { action: "start" } })).json();
  ok("2FA setup provides a QR and secret", typeof setup.secret === "string" && setup.qr?.startsWith("data:image/png"));
  const activated = await call("/api/auth/totp", { method: "POST", json: { action: "activate", code: authenticator.generate(setup.secret) } });
  const codes = (await activated.json()).recoveryCodes;
  ok("authenticator enrollment succeeds", activated.status === 200 && codes?.length === 10);
  const staleSession = await fetch(`${BASE}/api/projects`, { headers: { Cookie: `vpm_session=${oldSession}` } });
  ok("enrollment revokes old sessions", staleSession.status === 401);
  ok("2FA status is enabled", (await (await call("/api/auth/totp")).json()).hasTotp === true);
  const unauthDisable = await call("/api/auth/totp", { method: "POST", json: { action: "disable" } });
  ok("2FA disable requires credentials", unauthDisable.status === 401);
  ok("cannot silently replace active 2FA", (await call("/api/auth/totp", { method: "POST", json: { action: "start" } })).status === 409);
  await call("/api/auth/logout", { method: "POST" });
  jar.set("vpm_pre", "1");
  const forged = await call("/api/auth/login", { method: "POST", json: { phase: "totp", totp: authenticator.generate(setup.secret) } });
  ok("forged user-id challenge is rejected", forged.status === 401 && !jar.has("vpm_session"));
  jar.delete("vpm_pre");
  ok("password alone requires 2FA", (await (await login()).json()).needsTotp === true && !jar.has("vpm_session"));
  const challenge = jar.get("vpm_pre");
  const mfa = await call("/api/auth/login", { method: "POST", json: { phase: "totp", totp: authenticator.generate(setup.secret) } });
  ok("authenticator login succeeds", mfa.status === 200 && jar.has("vpm_session"));
  const replay = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { Cookie: `vpm_pre=${challenge}`, "Content-Type": "application/json" }, body: JSON.stringify({ phase: "totp", totp: authenticator.generate(setup.secret) }) });
  ok("login challenges are single use", replay.status === 401);
  await call("/api/auth/logout", { method: "POST" }); await login();
  const recovery = await call("/api/auth/login", { method: "POST", json: { phase: "totp", totp: codes[0] } });
  ok("recovery code logs in", recovery.status === 200);
  await call("/api/auth/logout", { method: "POST" }); await login();
  const reused = await call("/api/auth/login", { method: "POST", json: { phase: "totp", totp: codes[0] } });
  ok("recovery code cannot be reused", reused.status === 401);
  await call("/api/auth/login", { method: "POST", json: { phase: "totp", totp: codes[1] } });

  const newPassword = "changed-test-password-456";
  const beforeChange = jar.get("vpm_session");
  const change = await call("/api/auth/password", { method: "POST", json: { currentPassword: PASSWORD, newPassword, code: authenticator.generate(setup.secret) } });
  ok("password change succeeds with current credentials", change.status === 200);
  ok("password change invalidates other sessions", (await fetch(`${BASE}/api/projects`, { headers: { Cookie: `vpm_session=${beforeChange}` } })).status === 401);
  const disable = await call("/api/auth/totp", { method: "POST", json: { action: "disable", password: newPassword, code: authenticator.generate(setup.secret) } });
  ok("2FA disable works with current credentials", disable.status === 200);
  await call("/api/auth/logout", { method: "POST" });
  ok("old password no longer works", (await login()).status === 401);
  ok("new password works", (await login(newPassword)).status === 200);
  // Restore fixture credentials for reruns and optional browser verification.
  await call("/api/auth/password", { method: "POST", json: { currentPassword: newPassword, newPassword: PASSWORD } });
  await call("/api/auth/logout", { method: "POST" });
  const malformed = await call("/api/auth/login", { method: "POST", json: { username: 123, password: [] } });
  ok("malformed auth input is rejected cleanly", malformed.status === 400);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
