import "server-only";
import { getProject } from "./projects";
import { run } from "./exec";
import { lockProject } from "./project-lock";
import { configureAutomation } from "./automation";
import { audit } from "./audit";

export const STACK_ACTIONS = ["start", "stop", "restart"] as const;
export type StackAction = typeof STACK_ACTIONS[number];

export async function controlStack(project: string, action: StackAction, meta: { user: string; ip: string }) {
  if (!STACK_ACTIONS.includes(action)) throw new Error("unsupported stack action");
  const info = getProject(project);
  if (!info.composeFile) throw new Error("project has no Compose file");
  const release = lockProject(info.absPath, action);
  try {
    // Stopping a stack also pauses Git deployment, so the worker cannot start it.
    if (action === "stop") configureAutomation(info.absPath, false, 300, meta);
    const args = action === "start" ? ["up", "-d", "--no-build"] : action === "stop" ? ["stop", "--timeout", "30"] : ["restart", "--timeout", "30"];
    const result = await run("docker", ["compose", "-f", info.composeFile, ...args], { cwd: info.absPath, timeoutMs: 180_000 });
    audit({ ...meta, action: `stack.${action}`, target: info.absPath, ok: result.code === 0 });
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || `Stack ${action} failed`);
    return result.stdout || result.stderr || `Stack ${action} completed`;
  } finally { release(); }
}
