"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ServerOverview } from "../server/server-overview";

interface Project {
  name: string;
  path: string;
  isGitRepo: boolean;
  branch: string | null;
  commitShort: string | null;
  dirty: boolean;
  ahead: number | null;
  behind: number | null;
  remote: string | null;
  composeFile: string | null;
  services: string[];
  image: string | null;
  hasEnvFile: boolean;
  envKeys: string[];
  mtimeIso: string | null;
}

interface Capabilities {
  git: boolean;
  docker: boolean;
  dockerCompose: boolean;
  host: string;
  platform: string;
  uptimeSec: number;
  loadavg: number[];
  totalMem: number;
  freeMem: number;
}

interface DeployRecord {
  id: string; project: string; status: string; started_at: number; branch: string | null;
}

export default function DashboardPage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [deployId, setDeployId] = useState<string | null>(null);
  const [logs, setLogs] = useState<{ label: string; status: string; output: string }[]>([]);
  const [history, setHistory] = useState<DeployRecord[]>([]);
  const [result, setResult] = useState<string | null>(null);
  const [containerOutput, setContainerOutput] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/projects");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setProjects(data.projects);
      setCaps(data.capabilities);
      setHistory(data.history ?? []);
      if (data.active?.length) {
        setDeployId(data.active[0].id); setBusy(data.active[0].project);
      }
    } catch (e) {
      setError((e as Error).message);
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    // load() is async; state updates happen after the fetch resolves rather
    // than synchronously during render. The rule cannot see through the
    // async boundary.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Live-tail the running deploy over SSE.
  useEffect(() => {
    if (!deployId) return;
    const es = new EventSource(`/api/deploy/stream?id=${encodeURIComponent(deployId)}`);
    let poll: ReturnType<typeof setInterval> | undefined;
    let disposed = false;
    const update = (state: { status: string; error?: string; steps?: { label: string; status: string; output: string }[] }) => {
      if (disposed) return;
      setLogs(
        (state.steps ?? []).map((s: { label: string; status: string; output: string }) => ({
          label: s.label,
          status: s.status,
          output: s.output,
        })),
      );
      if (state.status !== "running" && state.status !== "queued") {
        es.close();
        if (poll) clearInterval(poll);
        setBusy(null);
        setDeployId(null);
        setResult(state.status);
        if (state.error) setError(state.error);
        void load();
      }
    };
    es.addEventListener("deploy", (e) => update(JSON.parse((e as MessageEvent).data)));
    es.onerror = () => {
      es.close();
      const refresh = async () => {
        try {
          const response = await fetch(`/api/deploy?id=${encodeURIComponent(deployId)}`);
          const state = await response.json();
          if (!response.ok) throw new Error(state.error ?? "Could not read deploy status");
          update(state);
        } catch (e) { if (!disposed) setError((e as Error).message); }
      };
      poll = setInterval(() => void refresh(), 3000);
      void refresh();
    };
    return () => { disposed = true; es.close(); if (poll) clearInterval(poll); };
  }, [deployId, load]);

  async function deploy(p: Project) {
    if (p.dirty && !confirm(`Deploy ${p.name}? This discards uncommitted changes in the project.`)) return;
    setBusy(p.name);
    setLogs([]);
    setResult(null); setError(null);
    try {
      const res = await fetch("/api/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: p.path, build: true, autoRollback: true, healthTimeoutSec: 60 }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error);
        setBusy(null);
        return;
      }
      setDeployId(data.id);
    } catch {
      setError("failed to start deploy");
      setBusy(null);
    }
  }

  async function inspect(p: Project, action: "ps" | "logs") {
    setContainerOutput(`Loading ${action} for ${p.name}…`);
    try {
      const response = await fetch(`/api/docker?project=${encodeURIComponent(p.path)}&action=${action}`);
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error ?? "Docker inspection failed");
      setContainerOutput(data.output || "No containers or output.");
    } catch (e) { setContainerOutput((e as Error).message); }
  }

  async function viewHistory(id: string) {
    try {
      const response = await fetch(`/api/deploy?id=${encodeURIComponent(id)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setLogs(data.steps ?? []); setResult(data.status);
    } catch (e) { setError((e as Error).message); }
  }

  async function abort() {
    if (!deployId) return;
    const response = await fetch(`/api/deploy?id=${encodeURIComponent(deployId)}`, { method: "DELETE" });
    const data = await response.json();
    if (!response.ok) setError(data.error);
    else setResult("Abort requested; waiting for the current command to finish.");
  }

  if (error && projects === null) {
    return <p className="rounded-lg border border-red-900 bg-red-950/40 p-4 text-red-300">{error}</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Projects</h1>
          <p className="text-sm text-zinc-500">
            Discovered under your configured roots.
          </p>
        </div>
        <button
          onClick={load}
          className="rounded-lg border border-zinc-800 px-3 py-1.5 text-sm text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200"
        >
          Refresh
        </button>
      </div>

      {error && <p role="alert" className="rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">{error}</p>}
      {result && <p role="status" className="text-sm text-zinc-300">Deploy: {result.replaceAll("_", " ")}</p>}
      <ServerOverview />

      {caps && !caps.dockerCompose && (
        <div className="rounded-lg border border-amber-900 bg-amber-950/30 p-3 text-sm text-amber-300">
          {caps.docker
            ? "The docker binary is present but the docker compose plugin is not usable. Deploys will fail until compose is installed and this process can reach the docker socket."
            : "docker was not found on PATH. Deploys will fail until it is installed and this process can reach the docker socket."}
        </div>
      )}

      {projects && projects.length === 0 && (
        <p className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-6 text-center text-sm text-zinc-500">
          No projects found. Check the <code className="text-zinc-400">VPM_ROOTS</code> environment
          variable, or create a directory with a <code className="text-zinc-400">docker-compose.yml</code>.
        </p>
      )}

      <div className="grid gap-3">
        {projects?.map((p) => (
          <div
            key={p.path}
            className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 transition hover:border-zinc-700"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="truncate font-medium">{p.name}</h2>
                  {p.dirty && (
                    <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-400">
                      uncommitted changes
                    </span>
                  )}
                  {!p.composeFile && (
                    <span className="rounded bg-zinc-700/50 px-1.5 py-0.5 text-[10px] text-zinc-400">
                      no compose file
                    </span>
                  )}
                </div>
                <p className="mt-0.5 truncate font-mono text-xs text-zinc-500">{p.path}</p>

                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
                  {p.branch && (
                    <span>
                      ⎇ <span className="text-zinc-300">{p.branch}</span>
                      {p.commitShort && <span className="ml-1 font-mono">{p.commitShort}</span>}
                    </span>
                  )}
                  {p.behind !== null && p.behind > 0 && (
                    <span className="text-sky-400">↓{p.behind} behind</span>
                  )}
                  {p.ahead !== null && p.ahead > 0 && (
                    <span className="text-amber-400">↑{p.ahead} ahead</span>
                  )}
                  {p.image && <span className="font-mono">{p.image}</span>}
                  {p.hasEnvFile && (
                    <span className="text-emerald-500">.env ({p.envKeys.length} keys)</span>
                  )}
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {p.composeFile && <>
                  <button onClick={() => inspect(p, "ps")} className="text-xs text-zinc-400">Containers</button>
                  <button onClick={() => inspect(p, "logs")} className="text-xs text-zinc-400">Logs</button>
                </>}
                <Link
                  href={`/files?path=${encodeURIComponent(p.path)}`}
                  className="rounded-lg border border-zinc-800 px-3 py-1.5 text-sm text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200"
                >
                  Files
                </Link>
                <button
                  onClick={() => deploy(p)}
                  disabled={busy !== null || !p.composeFile || !caps?.dockerCompose}
                  className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:opacity-40"
                >
                  {busy === p.name ? "Deploying…" : "Deploy"}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {logs.length > 0 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-950">
          <div className="border-b border-zinc-800 px-4 py-2 text-sm font-medium">
            Deploy output
            {busy && <span className="ml-2 text-emerald-400">● running</span>}
            {deployId && <button onClick={abort} className="ml-3 text-xs text-red-400">Abort deploy</button>}
          </div>
          <div className="divide-y divide-zinc-900">
            {logs.map((l, i) => (
              <div key={i} className="px-4 py-2">
                <div className="flex items-center gap-2 text-xs">
                  <StatusDot status={l.status} />
                  <span className="text-zinc-300">{l.label}</span>
                </div>
                {l.output && <pre className="deploy-log mt-1 max-h-64 overflow-auto text-zinc-500">{l.output}</pre>}
              </div>
            ))}
          </div>
        </div>
      )}

      {containerOutput !== null && <section className="rounded-xl border border-zinc-800 p-4">
        <div className="flex justify-between text-sm"><h2>Container output</h2><button onClick={() => setContainerOutput(null)} className="text-zinc-500">Close</button></div>
        <pre className="deploy-log mt-3 max-h-80 overflow-auto text-zinc-400">{containerOutput}</pre>
      </section>}
      {history.length > 0 && <section className="rounded-xl border border-zinc-800 p-4">
        <h2 className="mb-3 text-sm font-medium">Recent deployments</h2>
        <div className="space-y-2">{history.map((record) => <button disabled={!!busy} onClick={() => viewHistory(record.id)} key={record.id} className="flex w-full flex-wrap gap-3 rounded bg-zinc-900 p-3 text-left text-xs disabled:opacity-40">
          <span className="font-medium text-zinc-200">{record.project}</span><span className="text-zinc-400">{record.branch}</span><span className={record.status === "succeeded" ? "text-emerald-400" : "text-amber-400"}>{record.status.replaceAll("_", " ")}</span><time className="ml-auto text-zinc-500">{new Date(record.started_at).toLocaleString()}</time>
        </button>)}</div>
      </section>}

    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  if (status === "ok") return <span className="text-emerald-400">✓</span>;
  if (status === "failed") return <span className="text-red-400">✕</span>;
  if (status === "running") return <span className="animate-pulse-dot text-sky-400">●</span>;
  return <span className="text-zinc-600">○</span>;
}
