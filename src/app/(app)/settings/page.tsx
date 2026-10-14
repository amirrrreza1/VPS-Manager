"use client";

import { useEffect, useState } from "react";

export default function SettingsPage() {
  const [hasTotp, setHasTotp] = useState<boolean | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [securityCode, setSecurityCode] = useState("");

  useEffect(() => {
    fetch("/api/auth/totp")
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? "Could not load settings");
        return data;
      })
      .then((d) => {
        setHasTotp(d.hasTotp);
      })
      .catch((e) => setError(e.message));
  }, []);

  async function request(path: string, body: Record<string, string>) {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const response = await fetch(path, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Request failed");
      return data;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function enable() {
      const data = await request("/api/auth/totp", { action: "activate", code });
      if (!data) return;
      setRecovery(data.recoveryCodes);
      setHasTotp(true);
      setQr(null);
      setSecret(null);
      setCode("");
      setInfo("Two-factor authentication enabled.");
  }

  async function disable() {
    if (!confirm("Disable two-factor authentication?")) return;
    const data = await request("/api/auth/totp", { action: "disable", password: currentPassword, code: securityCode });
    if (data) {
      setHasTotp(false);
      setInfo("Two-factor authentication disabled.");
      setCurrentPassword("");
      setSecurityCode("");
    }
  }

  async function showSetup() {
    const data = await request("/api/auth/totp", { action: "start" });
    if (data) { setQr(data.qr); setSecret(data.secret); setCode(""); }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) { setError("New passwords do not match."); return; }
    const data = await request("/api/auth/password", { currentPassword, newPassword, code: securityCode });
    if (data) {
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword(""); setSecurityCode("");
      setInfo("Password changed. Other sessions have been signed out.");
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Settings</h1>
        <p className="text-sm text-zinc-500">Security and deployment configuration.</p>
      </div>

      {info && (
        <p className="rounded-lg border border-emerald-900 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-300">
          {info}
        </p>
      )}
      {error && (
        <p className="rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <h2 className="font-medium">Two-factor authentication</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Require a TOTP code from your authenticator app at every login. Strongly recommended — this
          panel can read your <code className="text-zinc-400">.env</code> files and restart your
          containers.
        </p>

        {hasTotp === null ? <p className="mt-4 text-sm text-zinc-500">Loading security settings…</p> : recovery ? (
          <div className="mt-4 space-y-3">
            <p className="text-sm text-amber-300">
              Save these recovery codes now. Each works once if you lose your authenticator.
            </p>
            <div className="grid grid-cols-2 gap-2 rounded-lg bg-zinc-950 p-3 font-mono text-xs">
              {recovery.map((c) => (
                <span key={c}>{c}</span>
              ))}
            </div>
            <button
              onClick={async () => {
                try { await navigator.clipboard.writeText(recovery.join("\n")); setInfo("Recovery codes copied to clipboard."); }
                catch { setError("Could not copy codes. Select and save them manually."); }
              }}
              className="rounded-lg border border-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:border-zinc-700"
            >
              Copy codes
            </button>
            <button onClick={() => setRecovery(null)} className="ml-2 text-sm text-zinc-400">I saved my codes</button>
          </div>
        ) : hasTotp === false ? (
          <div className="mt-4 flex gap-2">
            <button
              onClick={showSetup}
              disabled={busy || !!qr}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500"
            >
              Enable 2FA
            </button>
          </div>
        ) : (
          <div className="mt-4 flex gap-2">
            <button
              onClick={disable}
              disabled={busy || !currentPassword || securityCode.length !== 6}
              className="rounded-lg border border-red-900 px-3 py-1.5 text-sm text-red-400 hover:bg-red-950/40"
            >
              Disable 2FA
            </button>
          </div>
        )}
        {hasTotp && !recovery && <p className="mt-3 text-xs text-zinc-500">2FA is enabled. To disable it, enter your current password and authenticator code below.</p>}
      </section>

      {qr && secret && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <h2 className="font-medium">Scan this code</h2>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qr} alt="TOTP QR code" className="my-4 rounded-lg bg-white p-2" width={200} height={200} />
          <p className="text-xs text-zinc-500">
            Or enter this key manually: <code className="text-zinc-300">{secret}</code>
          </p>
          <div className="mt-3 flex gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="6-digit code"
              inputMode="numeric"
              className="w-40 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 font-mono text-sm outline-none focus:border-emerald-500"
            />
            <button
              onClick={enable}
              aria-label="Authenticator code"
              disabled={busy || code.length !== 6}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
            >
              Confirm
            </button>
          </div>
        </section>
      )}

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <h2 className="font-medium">Change password</h2>
        <p className="mt-1 text-sm text-zinc-500">Use 12–200 characters. Changing security settings signs out other sessions.</p>
        <form onSubmit={changePassword} className="mt-4 space-y-3">
          <label className="block text-sm text-zinc-400">Current password
            <input type="password" autoComplete="current-password" required maxLength={200} value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} className="mt-1 block w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2" />
          </label>
          {hasTotp && <label className="block text-sm text-zinc-400">Authenticator code
            <input inputMode="numeric" autoComplete="one-time-code" value={securityCode} onChange={(e) => setSecurityCode(e.target.value.replace(/\D/g, "").slice(0, 6))} className="mt-1 block w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2" />
          </label>}
          <label className="block text-sm text-zinc-400">New password
            <input type="password" autoComplete="new-password" required minLength={12} maxLength={200} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="mt-1 block w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2" />
          </label>
          <label className="block text-sm text-zinc-400">Confirm new password
            <input type="password" autoComplete="new-password" required minLength={12} maxLength={200} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className="mt-1 block w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2" />
          </label>
          <button disabled={busy || hasTotp === null} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm text-white disabled:opacity-40">Change password</button>
        </form>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <h2 className="font-medium">Deployment defaults</h2>
        <ul className="mt-2 space-y-1 text-sm text-zinc-500">
          <li>• <code className="text-zinc-400">.env</code> files are backed up before each deploy</li>
          <li>• Git updates use <code className="text-zinc-400">reset --hard</code> to your origin branch</li>
          <li>• Failed health checks roll back automatically</li>
          <li>• Set <code className="text-zinc-400">VPM_ROOTS</code> to change which directories are visible</li>
        </ul>
      </section>
    </div>
  );
}
