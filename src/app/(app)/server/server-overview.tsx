"use client";

import Link from "next/link";
import { useServerInfo } from "./use-server-info";
import type { ServerSnapshot } from "@/lib/server-types";

export function bytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return "Unavailable";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value; let index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index++; }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
export function percentage(value: number | null): string { return value === null ? "Sampling…" : `${value.toFixed(1)}%`; }
export function uptime(value: number): string {
  const days = Math.floor(value / 86400); const hours = Math.floor(value % 86400 / 3600); const minutes = Math.floor(value % 3600 / 60);
  return days ? `${days}d ${hours}h ${minutes}m` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}
export function sourceLabel(data: ServerSnapshot): string {
  return data.source === "host" ? "VPS host" : data.source === "container" ? "Container environment" : data.identity.os.toLowerCase().includes("windows") || data.identity.kernel.toLowerCase().includes("windows") ? "Local Windows machine" : "Server host";
}

export function ResourceCard({ label, value, detail, percent, children }: { label: string; value: string; detail: string; percent?: number | null; children?: React.ReactNode }) {
  const color = percent !== null && percent !== undefined && percent >= 90 ? "bg-red-400" : percent !== null && percent !== undefined && percent >= 75 ? "bg-amber-400" : "bg-emerald-400";
  return <div className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4"><p className="text-xs font-medium text-zinc-500">{label}</p><p className="mt-2 break-all text-xl font-semibold tracking-tight text-zinc-100">{value}</p><p className="mt-1 text-xs text-zinc-500">{detail}</p>{percent !== undefined && <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined} className="mt-3 h-1.5 overflow-hidden rounded-full bg-zinc-800"><div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, Math.max(0, percent ?? 0))}%` }} /></div>}{children}</div>;
}

export function SummaryCards({ data }: { data: ServerSnapshot }) {
  const volume = data.storage[0];
  return <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
    <ResourceCard label="CPU usage" value={percentage(data.cpu.usagePercent)} detail={`${data.cpu.logicalCores} logical CPUs · ${data.cpu.availableCores} available to panel`} percent={data.cpu.usagePercent} />
    <ResourceCard label="Memory usage" value={`${bytes(data.memory.used)} / ${bytes(data.memory.total)}`} detail={`${bytes(data.memory.available)} available · ${percentage(data.memory.percent)} used`} percent={data.memory.percent} />
    <ResourceCard label={volume ? `Storage · ${volume.label}` : "Storage"} value={volume ? `${bytes(volume.used)} / ${bytes(volume.total)}` : "Unavailable"} detail={volume ? `${bytes(volume.available)} available at ${volume.path}` : "No accessible storage volume"} percent={volume?.percent} />
    <ResourceCard label="Server uptime" value={uptime(data.identity.uptimeSec)} detail={`${data.docker.available ? `${data.docker.running} containers running` : "Docker unavailable"} · ${data.processes.total} visible processes`} />
  </div>;
}

export function ServerOverview() {
  const { data, error } = useServerInfo();
  return <section aria-label="Server overview" className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-sm font-semibold">Server overview</h2><p className="mt-1 text-xs text-zinc-500">{data ? `${sourceLabel(data)} · ${data.identity.hostname} · ${data.identity.os}` : "Reading server resources…"}</p></div><Link href="/server" className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-emerald-400 hover:bg-zinc-900">View server details →</Link></div>
    {error && <p role="alert" className="text-xs text-amber-300">{error}</p>}
    {data ? <SummaryCards data={data} /> : <div role="status" className="rounded-xl border border-zinc-800 p-5 text-sm text-zinc-500">Loading CPU, memory, storage and service information…</div>}
  </section>;
}
