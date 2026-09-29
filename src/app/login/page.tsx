"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phase: "password", username, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "login failed");
        return;
      }
      if (data.needsTotp) {
        setNeedsTotp(true);
        return;
      }
      router.push(data.redirect ?? "/dashboard");
      router.refresh();
    } catch {
      setError("network error");
    } finally {
      setBusy(false);
    }
  }

  async function submitTotp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phase: "totp", totp }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "verification failed");
        return;
      }
      router.push(data.redirect ?? "/dashboard");
      router.refresh();
    } catch {
      setError("network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex-1 flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/10 text-xl">
            ⬢
          </div>
          <h1 className="text-xl font-semibold">VPS Manager</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {needsTotp ? "Enter your authenticator code" : "Sign in to continue"}
          </p>
        </div>

        <form
          onSubmit={needsTotp ? submitTotp : submitPassword}
          className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-6"
        >
          {!needsTotp ? (
            <>
              <label className="block">
                <span className="mb-1.5 block text-sm text-zinc-400">Username</span>
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  autoFocus
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-emerald-500"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-sm text-zinc-400">Password</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-emerald-500"
                />
              </label>
            </>
          ) : (
            <label className="block">
              <span className="mb-1.5 block text-sm text-zinc-400">6-digit code</span>
              <input
                value={totp}
                onChange={(e) => setTotp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-center font-mono text-2xl tracking-[0.3em] outline-none focus:border-emerald-500"
              />
            </label>
          )}

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
            {busy ? "Verifying…" : needsTotp ? "Verify" : "Sign in"}
          </button>

          {needsTotp && (
            <button
              type="button"
              onClick={() => {
                setNeedsTotp(false);
                setTotp("");
                setError(null);
              }}
              className="w-full text-center text-xs text-zinc-500 hover:text-zinc-300"
            >
              ← back
            </button>
          )}
        </form>
      </div>
    </main>
  );
}
