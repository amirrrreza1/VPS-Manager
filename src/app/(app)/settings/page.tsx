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

  useEffect(() => {
    fetch("/api/auth/totp", { method: "POST", body: JSON.stringify({ action: "start" }) })
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          // Setup data is fetched but not shown until requested; the QR is only
          // rendered when the operator clicks enable.
          sessionStorage.setItem("vpm_totp_qr", d.qr);
          sessionStorage.setItem("vpm_totp_secret", d.secret);
        } else {
          setError(d.error);
        }
      });
  }, []);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then(() => undefined)
      .catch(() => undefined);
  }, []);

  async function enable() {
    setError(null);
    try {
      const res = await fetch("/api/auth/totp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "activate", code }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error);
        return;
      }
      setRecovery(data.recoveryCodes);
      setHasTotp(true);
      setQr(null);
      sessionStorage.removeItem("vpm_totp_qr");
      sessionStorage.removeItem("vpm_totp_secret");
      setInfo("Two-factor authentication enabled.");
    } catch {
      setError("request failed");
    }
  }

  async function disable() {
    if (!confirm("Disable two-factor authentication?")) return;
    const res = await fetch("/api/auth/totp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "disable" }),
    });
    if (res.ok) {
      setHasTotp(false);
      setInfo("Two-factor authentication disabled.");
    }
  }

  function showSetup() {
    setQr(sessionStorage.getItem("vpm_totp_qr"));
    setSecret(sessionStorage.getItem("vpm_totp_secret"));
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

        {recovery ? (
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
              onClick={() => {
                void navigator.clipboard?.writeText(recovery.join("\n"));
                setInfo("Recovery codes copied to clipboard.");
              }}
              className="rounded-lg border border-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:border-zinc-700"
            >
              Copy codes
            </button>
          </div>
        ) : hasTotp === false ? (
          <div className="mt-4 flex gap-2">
            <button
              onClick={showSetup}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500"
            >
              Enable 2FA
            </button>
          </div>
        ) : (
          <div className="mt-4 flex gap-2">
            <button
              onClick={disable}
              className="rounded-lg border border-red-900 px-3 py-1.5 text-sm text-red-400 hover:bg-red-950/40"
            >
              Disable 2FA
            </button>
          </div>
        )}
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
              disabled={code.length !== 6}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
            >
              Confirm
            </button>
          </div>
        </section>
      )}

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
