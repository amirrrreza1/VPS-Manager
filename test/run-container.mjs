import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { randomUUID } from "node:crypto";

const image = "vps-manager:verify";
const socket = "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock";
const name = `vpm-image-verify-${randomUUID().slice(0, 8)}`;
let created = false;
async function run(args) {
  const child = spawn("docker", args, { stdio: "inherit", windowsHide: true });
  const [code] = await once(child, "exit");
  if (code !== 0) throw new Error(`Docker ${args[0]} exited with ${code}`);
}

try {
  await run(["build", "-f", "deploy/Dockerfile", "-t", image, "."]);
  const group = execFileSync("docker", ["run", "--rm", "--mount", socket, "--entrypoint", "stat", image, "-c", "%g", "/var/run/docker.sock"], { encoding: "utf8", windowsHide: true }).trim();
  if (!/^\d+$/.test(group)) throw new Error("Could not identify the Docker socket group");
  // Keep the real entrypoint, command, healthcheck and non-root user.
  await run(["run", "-d", "--name", name, "--mount", socket, "--group-add", group,
    "--mount", `type=bind,source=${path.resolve("test")},target=/app/test,readonly`,
    image]);
  created = true;
  let healthy = false;
  for (let i = 0; i < 60; i++) {
    const state = JSON.parse(execFileSync("docker", ["inspect", "--format", "{{json .State}}", name], { encoding: "utf8", windowsHide: true }));
    if (state.Health?.Status === "healthy") { healthy = true; break; }
    if (!state.Running || state.Health?.Status === "unhealthy") break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!healthy) {
    await run(["logs", name]); throw new Error("Production entrypoint did not become healthy");
  }
  console.log("PASS production entrypoint and Docker healthcheck");
  await run(["exec", "--env", "VPM_VERIFY_CONTAINER=1", name, "node", "test/run-docker.mjs"]);
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally {
  if (created) {
    try { await run(["rm", "-f", "-v", name]); } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
