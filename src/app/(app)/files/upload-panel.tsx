"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "./file-icon";

export function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

interface Transfer { name: string; size: number; progress: number; state: "Queued" | "Uploading" | "Uploaded" | "Failed" | "Cancelled"; error?: string }

export function UploadPanel({ dir, limit, disabled, onBusyChange, onComplete }: {
  dir: string; limit: number; disabled: boolean; onBusyChange: (busy: boolean) => void; onComplete: () => void;
}) {
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const request = useRef<XMLHttpRequest | null>(null);
  const running = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => () => { cancelled.current = true; request.current?.abort(); }, []);

  async function upload(files: File[]) {
    if (running.current || disabled || files.length === 0) return;
    const destination = dir;
    running.current = true; cancelled.current = false;
    setBusy(true); onBusyChange(true);
    setTransfers(files.map((file) => ({ name: file.name, size: file.size, progress: 0, state: "Queued" })));
    const update = (index: number, values: Partial<Transfer>) => setTransfers((rows) => rows.map((row, i) => i === index ? { ...row, ...values } : row));
    try {
      for (const [index, file] of files.entries()) {
        if (cancelled.current) { update(index, { state: "Cancelled" }); continue; }
        if (file.size > limit) { update(index, { state: "Failed", error: `Exceeds the ${bytesLabel(limit)} limit` }); continue; }
        update(index, { state: "Uploading" });
        try {
          await new Promise<void>((resolve, reject) => {
            const xhr = new XMLHttpRequest(); request.current = xhr;
            xhr.open("POST", `/api/files/upload?dir=${encodeURIComponent(destination)}&name=${encodeURIComponent(file.name)}`);
            xhr.setRequestHeader("Content-Type", "application/octet-stream");
            xhr.upload.onprogress = (event) => { if (event.lengthComputable) update(index, { progress: Math.round(event.loaded / event.total * 100) }); };
            xhr.onload = () => {
              if (xhr.status >= 200 && xhr.status < 300) resolve();
              else {
                let message = xhr.status === 401 ? "Session expired. Please sign in again." : `Upload failed (${xhr.status})`;
                try { message = JSON.parse(xhr.responseText).error ?? message; } catch { /* proxy may return text */ }
                reject(new Error(message));
              }
            };
            xhr.onerror = () => reject(new Error("Connection lost. Refresh the folder to check whether the file arrived."));
            xhr.onabort = () => reject(new Error("Cancelled"));
            xhr.send(file);
          });
          update(index, { state: "Uploaded", progress: 100 });
        } catch (error) {
          update(index, { state: cancelled.current ? "Cancelled" : "Failed", error: cancelled.current ? undefined : (error as Error).message });
        } finally { request.current = null; }
      }
    } finally {
      running.current = false; setBusy(false); onBusyChange(false); onComplete();
      if (input.current) input.current.value = "";
    }
  }

  return <section aria-label="File uploads" className="space-y-3">
    <div
      onDragOver={(event) => { event.preventDefault(); if (!disabled && !busy) setDragging(true); }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
      onDrop={(event) => { event.preventDefault(); setDragging(false); void upload(Array.from(event.dataTransfer.files)); }}
      className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed p-4 ${dragging ? "border-emerald-500 bg-emerald-500/10" : "border-zinc-700 bg-zinc-900/30"}`}
    >
      <div className="flex min-w-0 items-center gap-3"><Icon name="upload" className="h-6 w-6 text-emerald-400" /><div className="min-w-0"><p className="text-sm text-zinc-200">Drop files here or choose files to upload</p><p className="mt-1 break-all text-xs text-zinc-500">To {dir} · {bytesLabel(limit)} per file · Existing files are kept</p></div></div>
      <button disabled={disabled || busy} onClick={() => input.current?.click()} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40">Upload files</button>
      <input ref={input} aria-label="Upload files" type="file" multiple className="hidden" onChange={(event) => void upload(Array.from(event.target.files ?? []))} />
    </div>
    {transfers.length > 0 && <div className="rounded-xl border border-zinc-800 p-3">
      <div className="mb-2 flex items-center justify-between"><p role="status" className="text-xs text-zinc-400">{busy ? "Uploading…" : "Uploads finished"}</p>{busy ? <button onClick={() => { cancelled.current = true; request.current?.abort(); }} className="text-xs text-red-300">Cancel uploads</button> : <button onClick={() => setTransfers([])} className="text-xs text-zinc-500">Dismiss</button>}</div>
      <ul className="max-h-52 space-y-2 overflow-auto">{transfers.map((transfer, index) => <li key={index} className="text-xs"><div className="flex justify-between gap-3"><span className="truncate text-zinc-300">{transfer.name} <span className="text-zinc-500">{bytesLabel(transfer.size)}</span></span><span className={transfer.state === "Failed" ? "text-red-300" : transfer.state === "Uploaded" ? "text-emerald-400" : "text-zinc-400"}>{transfer.state}{transfer.state === "Uploading" ? ` ${transfer.progress}%` : ""}</span></div>{transfer.state === "Uploading" && <progress aria-label={`Upload progress for ${transfer.name}`} value={transfer.progress} max={100} className="mt-1 h-1 w-full accent-emerald-500" />}{transfer.error && <p role="alert" className="mt-1 text-red-300">{transfer.error}</p>}</li>)}</ul>
    </div>}
  </section>;
}
