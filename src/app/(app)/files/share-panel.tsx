"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Share { id: string; name: string; path: string; expiresAt: number; oneTime: boolean; downloads: number; active: boolean }

export function SharePanel({ path, onClose }: { path: string | null; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  const [shares, setShares] = useState<Share[]>([]);
  const [expiry, setExpiry] = useState(24 * 60 * 60 * 1000);
  const [oneTime, setOneTime] = useState(false);
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/files/shares${path ? `?path=${encodeURIComponent(path)}` : ""}`, { signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Unable to load links");
    setShares(data.shares);
  }, [path]);

  useEffect(() => {
    dialog.current?.showModal();
    const controller = new AbortController();
    // refresh updates state only after the network request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh(controller.signal).catch((cause) => { if (!controller.signal.aborted) setError((cause as Error).message); });
    return () => controller.abort();
  }, [refresh]);

  async function create() {
    setBusy(true); setError(null); setStatus(null); setLink("");
    try {
      const response = await fetch("/api/files/shares", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, lifetimeMs: expiry, oneTime }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Unable to create link");
      setLink(new URL(data.downloadPath, window.location.origin).href); setCreatedId(data.id);
      await refresh();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function revoke(id: string) {
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/files/shares", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Unable to revoke link");
      if (id === createdId) setLink("");
      setStatus("Link revoked. Future downloads are blocked."); await refresh();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  return <dialog ref={dialog} onCancel={onClose} aria-labelledby="share-title" className="fixed inset-0 m-auto max-h-[85vh] w-[calc(100%-2rem)] max-w-xl overflow-auto rounded-2xl border border-zinc-700 bg-zinc-950 p-5 text-zinc-200 shadow-2xl backdrop:bg-black/70">
    <div className="flex items-center justify-between gap-4"><h2 id="share-title" className="font-semibold">{path ? "Share a download link" : "Manage download links"}</h2><button aria-label="Close sharing" onClick={onClose} className="rounded px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800">Close</button></div>
    {path && <div className="mt-4 space-y-4">
      <p className="break-all font-mono text-xs text-zinc-400">{path}</p>
      <p className="text-sm text-zinc-400">Anyone with this link can download this file without signing in until it expires or you revoke it. Copy it now; saved links cannot be copied again.</p>
      <div className="flex flex-wrap items-center gap-4"><label className="text-sm">Expires in <select aria-label="Link expiry" value={expiry} onChange={(event) => setExpiry(Number(event.target.value))} className="ml-2 rounded border border-zinc-700 bg-zinc-900 p-2"><option value={60 * 60 * 1000}>1 hour</option><option value={24 * 60 * 60 * 1000}>24 hours</option><option value={7 * 24 * 60 * 60 * 1000}>7 days</option></select></label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={oneTime} onChange={(event) => setOneTime(event.target.checked)} className="accent-emerald-500" />One download only</label></div>
      {oneTime && <p className="text-xs text-zinc-500">The first download request uses the link, even if cancelled. Messaging services that fetch attachments may use it before your recipient does.</p>}
      <button disabled={busy} onClick={create} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm text-white disabled:opacity-40">Create download link</button>
      {link && <div className="space-y-2"><label className="block text-xs text-zinc-400" htmlFor="download-link">Download link</label><div className="flex gap-2"><input id="download-link" ref={linkInput} value={link} readOnly className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 p-2 text-xs" /><button onClick={async () => { try { await navigator.clipboard.writeText(link); setStatus("Link copied."); } catch { linkInput.current?.select(); setStatus("Select and copy the link above."); } }} className="rounded border border-zinc-700 px-3 text-sm">Copy link</button></div></div>}
    </div>}
    {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
    {status && <p role="status" className="mt-3 text-sm text-emerald-400">{status}</p>}
    <h3 className="mt-5 text-sm font-medium">{path ? "Links for this file" : "Recent links"}</h3>
    {shares.length === 0 ? <p className="mt-2 text-xs text-zinc-500">No links yet.</p> : <ul className="mt-2 space-y-2">{shares.map((share) => <li key={share.id} className="flex items-center gap-3 rounded-lg border border-zinc-800 p-3"><div className="min-w-0 flex-1"><p className="truncate text-sm">{share.name}</p><p className="mt-1 text-xs text-zinc-500">{share.active ? `Expires ${new Date(share.expiresAt).toLocaleString()}` : "Inactive"} · {share.downloads} download(s){share.oneTime ? " · One-time" : ""}</p></div>{share.active && <button disabled={busy} onClick={() => revoke(share.id)} className="rounded border border-red-900 px-3 py-1.5 text-xs text-red-300 disabled:opacity-40">Revoke</button>}</li>)}</ul>}
    <p className="mt-4 text-xs text-zinc-500">Editing, replacing, renaming or deleting a file makes its existing links unavailable.</p>
  </dialog>;
}
