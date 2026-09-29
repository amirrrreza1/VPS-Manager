"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function SetupPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("passwords do not match");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "setup failed");
        return;
      }
      router.push("/login");
    } catch {
      setError("network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex-1 flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <h1 className="mb-6 text-center text-xl font-semibold">First-run setup</h1>
        <form
          onSubmit={submit}
          className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-6"
        >
          <label className="block">
            <span className="mb-1.5 block text-sm text-zinc-400">Username</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-emerald-500"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm text-zinc-400">
              Password <span className="text-zinc-600">(min 12 characters)</span>
            </span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-emerald-500"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm text-zinc-400">Confirm password</span>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-emerald-500"
            />
          </label>

          {error && (
            <p className="rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create account"}
          </button>
        </form>
        <p className="mt-4 text-center text-xs text-zinc-600">
          This page closes permanently once an account exists.
        </p>
      </div>
    </main>
  );
}
