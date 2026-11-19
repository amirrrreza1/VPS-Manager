"use client";

import { useState } from "react";
import type { Automation } from "@/lib/automation";

const inputClass = "w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200";
const buttonClass = "rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40";

export function NewProject({ roots, canDeploy, onCreated }: { roots: string[]; canDeploy: boolean; onCreated: (project: { name: string; path: string; dirty: boolean }, deploy: boolean) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [template, setTemplate] = useState("repository");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const deploy = form.get("deploy") === "on";
    const body = { name: form.get("name"), root: form.get("root") || roots[0], template,
      ...(template === "repository" ? { repository: form.get("repository"), branch: form.get("branch") || undefined } : {}),
      ...(template === "image" ? { image: form.get("image") } : {}),
      hostPort: Number(form.get("hostPort")), containerPort: Number(form.get("containerPort") || 3000),
    };
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setOpen(false);
      await onCreated(result.project, deploy);
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  if (!open) return <button onClick={() => setOpen(true)} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500">New project or service</button>;
  return <section className="rounded-xl border border-emerald-900 bg-zinc-900/40 p-4">
    <div className="mb-4 flex justify-between"><h2 className="font-medium">New project or service</h2><button disabled={busy} onClick={() => setOpen(false)} className="text-sm text-zinc-400">Close</button></div>
    <form onSubmit={create} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1 text-xs text-zinc-400"><span>Project name</span><input required name="name" pattern="[a-z0-9]([a-z0-9]|-){0,62}" maxLength={63} placeholder="my-app" className={inputClass} /></label>
        <label className="space-y-1 text-xs text-zinc-400"><span>Project root</span><select name="root" className={inputClass}>{roots.map((root) => <option key={root}>{root}</option>)}</select></label>
        <label className="space-y-1 text-xs text-zinc-400"><span>Source</span><select value={template} onChange={(event) => setTemplate(event.target.value)} className={inputClass}>
          <option value="repository">Git repository</option><option value="static">Static website</option><option value="image">Docker image</option><option value="postgres">PostgreSQL database</option><option value="redis">Redis cache</option>
        </select></label>
        <label className="space-y-1 text-xs text-zinc-400"><span>VPS loopback port</span><input required type="number" name="hostPort" min={1024} max={65535} key={template} defaultValue={template === "postgres" ? 5432 : template === "redis" ? 6379 : 8080} className={inputClass} /></label>
        {template === "repository" && <>
          <label className="space-y-1 text-xs text-zinc-400"><span>Repository URL (HTTPS or SSH)</span><input required name="repository" placeholder="https://github.com/you/app.git" className={inputClass} /></label>
          <label className="space-y-1 text-xs text-zinc-400"><span>Branch (optional)</span><input name="branch" placeholder="Repository default" className={inputClass} /></label>
        </>}
        {template === "image" && <label className="space-y-1 text-xs text-zinc-400"><span>Image reference</span><input required name="image" placeholder="nginx:stable-alpine" className={inputClass} /></label>}
        {["repository", "image"].includes(template) && <label className="space-y-1 text-xs text-zinc-400"><span>Container port</span><input required type="number" name="containerPort" min={1} max={65535} defaultValue={3000} className={inputClass} /></label>}
      </div>
      <p className="text-xs text-zinc-500">Generated services restart after a crash or VPS reboot and bind to 127.0.0.1. Use your reverse proxy or an SSH tunnel to reach them. Repository Compose files retain their own port and restart settings.</p>
      {template === "repository" && <p className="text-xs text-zinc-500">Uses existing Compose, or generates it from a Dockerfile. An npm project with a lockfile and start script can also get a generated Dockerfile. Private repositories use the VPS Git credentials. Edit environment files in Files before deploying when needed.</p>}
      {template === "postgres" && <p className="text-xs text-zinc-500">Creates persistent storage and a random password in .env. Read it through Files to configure your application.</p>}
      {template === "redis" && <p className="text-xs text-zinc-500">Creates persistent Redis with append-only storage and a random password in .env. Access is restricted to VPS loopback.</p>}
      <label className="flex items-center gap-2 text-sm text-zinc-300"><input name="deploy" type="checkbox" defaultChecked={canDeploy && template !== "repository"} disabled={!canDeploy} /> Deploy immediately after creation</label>
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      <button disabled={busy || !roots.length} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm text-white disabled:opacity-40">{busy ? "Preparing project…" : "Create project"}</button>
    </form>
  </section>;
}

export function ProjectControls({ project, automation, disabled, onChange }: { project: { path: string; name: string; isGitRepo: boolean; composeFile: string | null }; automation?: Automation; disabled: boolean; onChange: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [interval, setInterval] = useState(automation?.interval_sec ?? 300);
  async function mutate(action: string) {
    if (action === "stop" && !confirm(`Stop ${project.name}? Automatic deployment will also be paused. Persistent volumes are kept.`)) return;
    setBusy(action); setError(null); setMessage(null);
    try {
      const automatic = action === "automation";
      const response = await fetch(automatic ? "/api/automation" : "/api/docker", { method: automatic ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(automatic ? { project: project.path, enabled: !automation?.enabled, intervalSec: interval } : { project: project.path, action }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setMessage(automatic ? `Automatic deployment ${automation?.enabled ? "paused" : "enabled"}.` : `${action[0].toUpperCase() + action.slice(1)} completed.`);
      await onChange();
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(null); }
  }
  if (!project.composeFile) return null;
  return <div className="mt-4 space-y-3 border-t border-zinc-800 pt-3">
    <div className="flex flex-wrap items-center gap-2">
      {(["start", "restart", "stop"] as const).map((action) => <button disabled={disabled || !!busy} key={action} onClick={() => void mutate(action)} className={buttonClass}>{busy === action ? "Working…" : action[0].toUpperCase() + action.slice(1)}</button>)}
      {project.isGitRepo && <>
        <label className="ml-auto flex items-center gap-2 text-xs text-zinc-500">Check Git every<select aria-label={`Git check interval for ${project.name}`} value={interval} onChange={(event) => setInterval(Number(event.target.value))} disabled={!!automation?.enabled || !!busy} className="rounded border border-zinc-800 bg-zinc-950 p-1"><option value={60}>1 minute</option><option value={300}>5 minutes</option><option value={900}>15 minutes</option><option value={3600}>1 hour</option></select></label>
        <button disabled={disabled || !!busy} onClick={() => void mutate("automation")} className={`${buttonClass} ${automation?.enabled ? "text-emerald-400" : ""}`}>{automation?.enabled ? "Pause auto deploy" : "Enable auto deploy"}</button>
      </>}
    </div>
    {!!automation?.enabled && <p className="text-xs text-zinc-500">Automatically deploys new origin commits with health checks and rollback. Server edits and local commits pause updates. Last check: {automation.checked_at ? new Date(automation.checked_at).toLocaleString() : "pending"}.</p>}
    {automation?.error && <p className="text-xs text-amber-400">{automation.error}</p>}
    {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
    {message && <p role="status" className="text-xs text-emerald-400">{message}</p>}
  </div>;
}
