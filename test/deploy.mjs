/**
 * Deploy pipeline test: runs a REAL deploy against a real git repo with a
 * real docker-compose file, then asserts HEAD moved and the container ran.
 *
 *   node test/deploy.mjs [baseUrl]
 */

const BASE = process.argv[2] ?? "http://localhost:3999";
const jar = new Map();

let pass = 0;
let fail = 0;
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
  if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  if (options.json) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.json);
  }
  const res = await fetch(`${BASE}${pathname}`, { ...options, headers, redirect: "manual" });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    if (/Max-Age=0/i.test(c)) jar.delete(pair.slice(0, i));
    else jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return res;
}

async function login() {
  await call("/api/setup", {
    method: "POST",
    json: { username: "smoke", password: "smoke-test-password-123" },
  });
  const res = await call("/api/auth/login", {
    method: "POST",
    json: { phase: "password", username: "smoke", password: "smoke-test-password-123" },
  });
  return res.status === 200;
}

console.log(`\nDeploy pipeline test against ${BASE}\n`);

console.log("Auth");
ok("logged in", await login());

console.log("\nDiscovery");
let project;
{
  const body = await (await call("/api/projects")).json();
  project = (body.projects ?? []).find((p) => p.name === "realapp");
  ok("realapp discovered", !!project, JSON.stringify((body.projects ?? []).map((p) => p.name)));
  ok("detected as a git repo", project?.isGitRepo === true);
  ok("detected compose file", project?.composeFile === "docker-compose.yml", String(project?.composeFile));
  ok("docker available on host", body.capabilities?.docker === true);
  ok("detected one service", project?.services?.includes("app"), JSON.stringify(project?.services));
  ok("sees it is behind origin", project?.behind === 1, `behind=${project?.behind}`);
}

console.log("\nStarting a real deploy");
let deployId;
{
  const res = await call("/api/deploy", {
    method: "POST",
    json: { project: project.path, build: true, backupEnv: true },
  });
  const body = await res.json();
  ok("deploy accepted", res.status === 200 && !!body.id, `got ${res.status} ${JSON.stringify(body)}`);
  deployId = body.id;
}

console.log("\nDuplicate deploy is refused");
{
  const res = await call("/api/deploy", { method: "POST", json: { project: project.path } });
  ok("second concurrent deploy rejected", res.status === 409, `got ${res.status}`);
}

console.log("\nWaiting for the pipeline to finish");
let final = null;
for (let i = 0; i < 180; i++) {
  const body = await (await call(`/api/deploy?id=${deployId}`)).json();
  if (body.status !== "running" && body.status !== "queued") {
    final = body;
    break;
  }
  process.stdout.write(".");
  await new Promise((r) => setTimeout(r, 2000));
}
console.log("");

ok("deploy reached a terminal state", !!final, "timed out after 6 minutes");
if (final) {
  console.log(`  status: ${final.status}`);
  for (const s of final.steps ?? []) {
    console.log(`   ${String(s.n).padStart(2)}. [${s.status}] ${s.label}`);
  }
  console.log("");

  const labels = (final.steps ?? []).map((s) => s.label);
  const statusOf = (frag) =>
    (final.steps ?? []).find((s) => s.label.includes(frag))?.status;

  ok("backed up .env first", labels.some((l) => /Back up environment/i.test(l)));
  ok("ran docker compose down", statusOf("compose down") === "ok", String(statusOf("compose down")));
  ok("ran git fetch", statusOf("git fetch") === "ok", String(statusOf("git fetch")));
  ok("ran the git update", statusOf("git reset --hard") === "ok" || statusOf("git pull") === "ok",
     String(statusOf("git reset --hard")));
  ok("ran docker compose up", statusOf("compose up") === "ok", String(statusOf("compose up")));

  ok("deploy succeeded overall", final.status === "succeeded", `${final.status}: ${final.error ?? ""}`);
  ok("commit changed during deploy", final.commitBefore !== final.commitAfter,
     `${final.commitBefore?.slice(0,7)} -> ${final.commitAfter?.slice(0,7)}`);
}

console.log("\nVerifying the deployed result on disk");
{
  const body = await (await call("/api/projects?name=realapp")).json();
  ok("HEAD now matches origin", body.project?.commit === final?.commitAfter,
     `${body.project?.commit?.slice(0,7)} vs ${final?.commitAfter?.slice(0,7)}`);
  ok("no longer behind origin", body.project?.behind === 0, `behind=${body.project?.behind}`);
}

console.log("\n.env survived the deploy");
{
  const body = await (await call("/api/files?action=read&path=/realapp/.env")).json();
  ok(".env still present and readable", typeof body.content === "string" && body.content.length > 0);
}

console.log("\nDeploy history persisted");
{
  const body = await (await call("/api/deploy")).json();
  const rec = (body.history ?? []).find((d) => d.id === deployId);
  ok("deploy recorded in history", !!rec);
  ok("history stores the step log", typeof rec?.log === "string" && rec.log.includes("label"));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
