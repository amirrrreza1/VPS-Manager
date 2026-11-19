"use client";

import { useCallback, useEffect, useState } from "react";

export function MaintenancePanel() {
  const [status, setStatus] = useState<{
    diskUsage: string;
    lastBackupAt: number | null;
    autoBackup: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/server/maintenance");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setStatus(data);
    } catch (error) {
      setError((error as Error).message);
    }
  }, []);
  useEffect(() => {
    // State updates occur after the network request completes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  async function run(action: string) {
    if (
      action === "clean-build-cache" &&
      !confirm(
        "Remove unused Docker build cache older than 7 days? Future builds may take longer. Running containers and volumes are kept."
      )
    )
      return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/server/maintenance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setMessage(data.output);
      await load();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4">
      <h2 className="text-sm font-semibold">Maintenance & backups</h2>
      <p className="mt-1 text-xs text-zinc-500">
        {status?.autoBackup
          ? "Daily database snapshots are enabled; the latest seven are retained."
          : "Daily database snapshots are disabled."}{" "}
        These snapshots cover panel accounts, settings and history. Back up
        project volumes and personal files separately to another machine.
      </p>
      <p className="mt-2 text-xs text-zinc-400">
        Last database snapshot:{" "}
        {status?.lastBackupAt
          ? new Date(status.lastBackupAt).toLocaleString()
          : "pending"}
      </p>
      <pre className="mt-3 overflow-auto text-xs text-zinc-400">
        {status?.diskUsage ?? "Reading Docker disk usage…"}
      </pre>
      <div className="mt-4 flex flex-wrap gap-2">
        {[
          ["backup", "Back up database now"],
          ["clean-build-cache", "Clean build cache older than 7 days"],
        ].map(([action, label]) => (
          <button
            key={action}
            disabled={busy}
            onClick={() => void run(action)}
            className="rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            {label}
          </button>
        ))}
        <button
          disabled={busy}
          onClick={() => void load()}
          className="px-3 py-2 text-xs text-zinc-500"
        >
          Refresh
        </button>
      </div>
      {busy && (
        <p role="status" className="mt-3 text-xs text-zinc-400">
          Maintenance in progress…
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-xs text-red-400">
          {error}
        </p>
      )}
      {message && (
        <pre
          role="status"
          className="mt-3 whitespace-pre-wrap text-xs text-emerald-400"
        >
          {message}
        </pre>
      )}
    </section>
  );
}
