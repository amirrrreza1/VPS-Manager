import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";

// A disposable production server: never creates users or edits real projects.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "vpm-e2e-"));
const root = path.join(temporary, "root");
const demo = path.join(root, "demo-api");
fs.mkdirSync(demo, { recursive: true });
fs.mkdirSync(path.join(root, "empty"));
fs.writeFileSync(path.join(demo, "index.ts"), "export async function main() {}\n");
fs.writeFileSync(path.join(demo, ".env"), "DATABASE_URL=postgres://user:changeme@localhost:5432/app\nSESSION_SECRET=replace-me\n");
fs.writeFileSync(path.join(demo, "docker-compose.yml"), "services:\n  app:\n    image: alpine\n");
const socket = net.createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
const port = socket.address().port; await new Promise((resolve) => socket.close(resolve));
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port), "-H", "127.0.0.1"], {
  env: { ...process.env, VPM_ROOTS: root, VPM_DATA_DIR: path.join(temporary, "data"), NEXT_TELEMETRY_DISABLED: "1" },
  stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
});
let output = "";
server.stdout.on("data", (chunk) => { output += chunk; }); server.stderr.on("data", (chunk) => { output += chunk; });
const base = `http://127.0.0.1:${port}`;
try {
  let ready = false;
  for (let i = 0; i < 100 && server.exitCode === null; i++) {
    try { const response = await fetch(`${base}/login`); if (response.ok) { ready = true; break; } } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error(`Test server did not start:\n${output}`);
  const test = spawn(process.execPath, ["test/e2e.mjs", base], { stdio: "inherit", windowsHide: true });
  const [code] = await once(test, "exit");
  if (code !== 0) { console.error(output); process.exitCode = code ?? 1; }
  if (process.argv.includes("--serve") && code === 0) {
    console.log(`Browser verification server: ${base}`);
    await new Promise((resolve) => {
      process.once("SIGINT", resolve); process.once("SIGTERM", resolve);
      process.stdin.resume(); process.stdin.once("data", resolve);
    });
    process.stdin.pause();
  }
} finally {
  server.kill(); if (server.exitCode === null) await once(server, "exit");
  fs.rmSync(temporary, { recursive: true, force: true });
}
