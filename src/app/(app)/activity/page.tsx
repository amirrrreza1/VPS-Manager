"use client";

import { useEffect, useState } from "react";

interface Entry {
  id: number;
  ts: number;
  user: string | null;
  action: string;
  target: string | null;
  detail: string | null;
  ip: string | null;
  ok: number;
}

export default function ActivityPage() {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/audit?limit=150")
      .then(async (r) => { const data = await r.json(); if (!r.ok) throw new Error(data.error ?? "Could not load activity"); return data; })
      .then((d) => setEntries(d.entries ?? []))
      .catch((e) => setError((e as Error).message));
  }, []);

  if (error) return <p className="text-red-400">{error}</p>;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Activity</h1>
        <p className="text-sm text-zinc-500">
          Every file change, deploy, and authentication event on this server.
        </p>
      </div>

      {!entries ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-zinc-900/60 text-xs text-zinc-500">
              <tr>
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Action</th>
                <th className="px-3 py-2 font-medium">Target</th>
                <th className="px-3 py-2 font-medium">User</th>
                <th className="px-3 py-2 font-medium">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-900">
              {entries.map((e) => (
                <tr key={e.id} className={e.ok ? "" : "bg-red-950/20"}>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-zinc-500">
                    {new Date(e.ts).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[11px] ${
                        e.ok
                          ? e.action.startsWith("deploy")
                            ? "bg-emerald-500/15 text-emerald-400"
                            : "bg-zinc-800 text-zinc-300"
                          : "bg-red-500/15 text-red-400"
                      }`}
                    >
                      {e.action}
                    </span>
                  </td>
                  <td className="max-w-md truncate px-3 py-2 font-mono text-xs text-zinc-400">
                    {e.target}
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-500">{e.user ?? "—"}</td>
                  <td className="px-3 py-2 font-mono text-xs text-zinc-600">{e.ip}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {entries.length === 0 && (
            <p className="p-6 text-center text-sm text-zinc-500">No activity recorded yet.</p>
          )}
        </div>
      )}
    </div>
  );
}
