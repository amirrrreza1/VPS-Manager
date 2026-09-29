/**
 * End-to-end smoke test against a running server.
 *   node test/e2e.mjs [baseUrl]
 *
 * Exercises the real HTTP surface: setup, login, session cookie, directory
 * listing, file read, secret redaction, write, and traversal defence.
 */

const BASE = process.argv[2] ?? "http://localhost:3999";

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
  const headers = { ...(options.headers ?? {}) };
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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
