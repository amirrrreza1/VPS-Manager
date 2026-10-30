import path from "node:path";
import { run as realRun, CommandError } from "../src/lib/exec.ts";
export { CommandError };
export const calls = [];
export const healthScenarios = new Map();
const builds = new Map();
export async function run(bin, args, options) {
  calls.push({ bin, args, cwd: options.cwd });
  if (bin !== "docker") return realRun(bin, args, options);
  const scenario = path.basename(options.cwd);
  await new Promise((resolve) => setTimeout(resolve, 20));
  let code = 0;
  let stdout = "";
  const health = healthScenarios.get(options.cwd);
  if (args.includes("config")) {
    code = health?.configCode ?? 0;
    stdout = JSON.stringify(health?.config ?? { services: { app: {} } });
  } else if (args.includes("ps")) {
    const states = health?.states ?? [{ Service: "app", State: "running", Health: "" }];
    stdout = scenario.includes("array") ? JSON.stringify(states) : states.map(JSON.stringify).join("\n");
  } else if (args.includes("up")) {
    const count = (builds.get(options.cwd) ?? 0) + 1; builds.set(options.cwd, count);
    if (scenario.includes("rollback") && count === 1) code = 1;
    if (scenario.includes("large")) {
      options.onOutput?.("first live chunk\n"); options.onOutput?.("x".repeat(700_000));
    }
  }
  return { code, stdout, stderr: code ? "simulated build failure" : "", durationMs: 20 };
}
