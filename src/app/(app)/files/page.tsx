"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { FileTree, type Entry } from "./file-tree";
import { fileIcon, Icon } from "./file-icon";
import { UploadPanel, bytesLabel } from "./upload-panel";
import { SharePanel } from "./share-panel";
import { MediaPreview } from "./media-preview";
import type { MediaPreview as MediaFormat } from "@/lib/media";

const FileEditor = dynamic(() => import("./file-editor"), {
  ssr: false,
  loading: () => <p role="status" className="p-6 text-sm text-zinc-500">Loading editor…</p>,
});

interface FileContent {
  path: string;
  name: string;
  content: string;
  size: number;
  mtimeMs: number;
  redacted: boolean;
  binary: boolean;
  editable: boolean;
  previewAvailable: boolean;
  mediaPreview: MediaFormat | null;
}

interface SearchHit {
  path: string;
  name: string;
  matches: { line: number; text: string }[];
}

export default function FilesPage() {
  const params = useSearchParams();
  const requestedPath = params.get("path") ?? "/@personal";
  const [cwd, setCwd] = useState<string>(requestedPath);
  const [browserPath, setBrowserPath] = useState<string>(requestedPath);
  const [revision, setRevision] = useState(0);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [file, setFile] = useState<FileContent | null>(null);
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [roots, setRoots] = useState<string[]>([]);
  const [mutating, setMutating] = useState(false);
  const [locations, setLocations] = useState<{ path: string; label: string }[]>([]);
  const [uploadLimit, setUploadLimit] = useState(1024 ** 3);
  const [shareTarget, setShareTarget] = useState<string | null | undefined>(undefined);
  const dirtyRef = useRef(false);

  const loadDir = useCallback(async (p: string, select = true) => {
    try {
      const res = await fetch(`/api/files?path=${encodeURIComponent(p)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(res.status === 401 ? "Session expired. Please sign in again." : data.error);
      setEntries(data.entries);
      setParent(data.parent);
      if (select) { setCwd(data.path); setBrowserPath(data.path); }
      setRevision((value) => value + 1);
      setRoots(data.roots ?? []);
      setLocations(data.locations ?? []);
      setUploadLimit(data.limits?.uploadBytes ?? 1024 ** 3);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      setEntries([]);
    }
  }, []);

  const openFile = useCallback(async (p: string, reveal = false) => {
    if (dirtyRef.current && !confirm("Discard unsaved changes?")) return;
    try {
      const infoRes = await fetch(`/api/files?action=info&path=${encodeURIComponent(p)}`);
      const info = await infoRes.json();
      if (!infoRes.ok) throw new Error(infoRes.status === 401 ? "Session expired. Please sign in again." : info.error);
      let data: FileContent = { ...info, content: "", redacted: false, binary: false };
      if (info.previewAvailable) {
        const res = await fetch(`/api/files?action=read&path=${encodeURIComponent(p)}${reveal ? "&reveal=1" : ""}`);
        const content = await res.json();
        if (!res.ok) throw new Error(res.status === 401 ? "Session expired. Please sign in again." : content.error);
        data = { ...content, previewAvailable: true, mediaPreview: info.mediaPreview };
      }
      setFile(data);
      setResults(null);
      setDraft(data.content);
      setDirty(false);
      dirtyRef.current = false;
      setRevealed(reveal);
      setStatus(null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    // loadDir is async: setState runs after the fetch resolves, not
    // synchronously, so this does not cascade renders. The rule cannot see
    // through the async boundary.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadDir(requestedPath);
  }, [loadDir, requestedPath]);

  // Warn before losing unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  async function save() {
    if (!file) return;
    // A masked file would write asterisks over the real secrets. The operator
    // must explicitly reveal before editing, so the on-disk value is in view.
    if (file.redacted && !revealed) {
      setError(
        "This file's values are hidden. Click \u201cReveal values\u201d before saving, or you would overwrite your real secrets with asterisks.",
      );
      return;
    }
    setStatus("saving…");
    setMutating(true);
    try {
      const res = await fetch("/api/files/mutate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "write", path: file.path, content: draft, expectedMtimeMs: file.mtimeMs }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setStatus(
        data.backupPath
          ? `saved ${data.bytes} bytes (backup: ${data.backupPath.split("/").pop()})`
          : `saved ${data.bytes} bytes`,
      );
      setDirty(false);
      dirtyRef.current = false;
      setFile({ ...file, content: draft, mtimeMs: data.mtimeMs, size: data.bytes });
      setError(null);
      void loadDir(browserPath, false);
    } catch (e) {
      setError((e as Error).message);
      setStatus(null);
    } finally {
      setMutating(false);
    }
  }


  async function doSearch() {
    if (query.trim().length < 2) return;
    setSearching(true);
    try {
      const res = await fetch(
        `/api/files/search?q=${encodeURIComponent(query)}&content=1&limit=40&dir=${encodeURIComponent(browserPath)}`,
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Search failed");
      setResults(data.results ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSearching(false);
    }
  }

  async function mutate(op: string, target?: string, name?: string) {
    const affectsOpenFile = !!(target && file && (file.path === target || file.path.startsWith(`${target}/`)));
    if (dirtyRef.current && affectsOpenFile && (op === "rename" || op === "delete") && !confirm("Discard unsaved changes?")) return;
    if (op === "delete" && !confirm(`Delete ${target}? Directories and their contents will be removed.`)) return;
    if (op !== "delete") {
      name = prompt(op === "rename" ? "New name" : op === "createDir" ? "Folder name" : "File name", name ?? "") ?? undefined;
      if (!name) return;
    }
    setMutating(true); setError(null);
    try {
      const res = await fetch("/api/files/mutate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op, path: target, dir: cwd, name, content: "" }) });
      const data = await res.json();
      if (!res.ok) throw new Error(res.status === 401 ? "Session expired. Please sign in again." : data.error ?? "Operation failed");
      if ((op === "rename" || op === "delete") && affectsOpenFile) {
        setFile(null); setDirty(false); dirtyRef.current = false;
      }
      if (target && (cwd === target || cwd.startsWith(`${target}/`))) {
        setCwd(op === "rename" ? `${data.path}${cwd.slice(target.length)}` : browserPath);
      }
      await loadDir(browserPath, false);
      if (op === "createFile") await openFile(data.path);
      setStatus(`${op === "delete" ? "Deleted" : op === "rename" ? "Renamed" : "Created"} ${name ?? target}`);
    } catch (e) { setError((e as Error).message); }
    finally { setMutating(false); }
  }

  return (
    <div className="space-y-4">
      <div><h1 className="text-lg font-semibold">File manager</h1><p className="mt-1 text-sm text-zinc-500">Store personal files on your VPS, download them, and share expiring links.</p></div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label>Location <select aria-label="File location" disabled={mutating} value={locations.find((location) => browserPath === location.path || (location.path !== "/" && browserPath.startsWith(`${location.path}/`)))?.path ?? (locations.some((location) => location.path === "/") && !browserPath.startsWith("/@personal") ? "/" : "")} onChange={(e) => { setResults(null); void loadDir(e.target.value); }} className="ml-2 max-w-64 rounded border border-zinc-700 bg-zinc-950 p-2"><option value="" disabled>Select location</option>{locations.map((location) => <option key={location.path} value={location.path}>{location.label}</option>)}</select></label>
        <button disabled={mutating} onClick={() => mutate("createFile")} className="flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2"><Icon name="file" />New file</button>
        <button disabled={mutating} onClick={() => mutate("createDir")} className="flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2"><Icon name="folder" />New folder</button>
        <button onClick={() => setShareTarget(null)} className="flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2"><Icon name="link" />Manage links</button>
        {mutating && <span className="text-zinc-500">Working…</span>}
      </div>
      <UploadPanel dir={cwd} limit={uploadLimit} disabled={mutating || entries === null} onBusyChange={setMutating} onComplete={() => void loadDir(browserPath, false)} />
      {shareTarget !== undefined && <SharePanel key={shareTarget ?? "all"} path={shareTarget} onClose={() => setShareTarget(undefined)} />}
      {status && !file && <p role="status" className="text-sm text-emerald-400">{status}</p>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{cwd.startsWith("/@personal") ? "Personal files" : "Project files"}</h2>
          <p className="break-all text-xs text-zinc-500">Create and upload in <span className="font-mono text-zinc-400">{cwd}</span></p>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void doSearch();
          }}
          className="flex w-full min-w-0 gap-2 sm:w-auto"
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search names + content…"
            className="min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-sm outline-none focus:border-emerald-500 sm:w-64"
          />
          <button
            type="submit"
            className="rounded-lg border border-zinc-800 px-3 py-1.5 text-sm text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
          >
            {searching ? "…" : "Search"}
          </button>
          {results && (
            <button
              type="button"
              onClick={() => {
                setResults(null);
                setQuery("");
              }}
              className="text-xs text-zinc-500 hover:text-zinc-300"
            >
              clear
            </button>
          )}
        </form>
      </div>

      {error && (
        <p role="alert" className="rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      {results ? (
        <div className="space-y-2">
          <p className="text-xs text-zinc-500">{results.length} match(es)</p>
          {results.map((r) => (
            <button
              key={r.path}
              onClick={() => openFile(r.path)}
              className="block w-full rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-left transition hover:border-zinc-700"
            >
              <div className="flex items-center gap-2 break-all font-mono text-sm text-zinc-200"><Icon name={fileIcon(r.name)} />{r.name}</div>
              <div className="break-all font-mono text-xs text-zinc-500">{r.path}</div>
              {r.matches.slice(0, 3).map((m, i) => (
                <div key={i} className="mt-1 truncate font-mono text-xs text-zinc-600">
                  {m.line}: {m.text.trim()}
                </div>
              ))}
            </button>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[400px_minmax(0,1fr)]">
          {/* ---- browser ---- */}
          <div className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-900/40">
            <div className="flex items-center gap-1 border-b border-zinc-800 p-2">
              <button
                onClick={() => parent && loadDir(parent)}
                disabled={!parent || mutating}
                aria-label="Browse parent folder"
                title="Browse parent folder"
                className="rounded p-2 text-zinc-400 hover:bg-zinc-800 disabled:opacity-30"
              >
                <Icon name="up" />
              </button>
              <button
                disabled={mutating}
                onClick={() => loadDir(browserPath.startsWith("/@personal") ? "/@personal" : roots.length > 1 ? roots.find((root) => browserPath === root || browserPath.startsWith(`${root}/`)) ?? "/" : "/")}
                className="flex items-center gap-2 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
              >
                <Icon name="folder" />Root
              </button>
              <button disabled={mutating} onClick={() => setCwd(browserPath)} title="Select this folder for new files and uploads" className="min-w-0 flex-1 truncate px-2 text-left font-mono text-xs text-zinc-500">{browserPath}</button>
              <button aria-label="Refresh files" title="Refresh files" onClick={() => loadDir(browserPath, false)} className="rounded p-2 text-zinc-400 hover:bg-zinc-800"><Icon name="refresh" /></button>
            </div>
            <div className="max-h-[70vh] overflow-auto">
              <FileTree key={browserPath} rootPath={browserPath} entries={entries} selectedDirectory={cwd} selectedFile={file?.path} revision={revision} mutating={mutating} onDirectorySelect={setCwd} onFileSelect={(path) => void openFile(path)} onRename={(path, name) => void mutate("rename", path, name)} onDelete={(path) => void mutate("delete", path)} />
            </div>
          </div>

          {/* ---- editor ---- */}
          <div className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-900/40">
            {!file ? (
              <p className="p-8 text-center text-sm text-zinc-500">
                Select a picture or video to preview it, or a text file to edit it. You can also download files and create share links.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 p-3">
                  <Icon name={fileIcon(file.name)} /><span title={file.path} className="break-all font-mono text-sm text-zinc-200">{file.name}</span>
                  {file.redacted && (
                    <span
                      className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-400"
                      title={
                        revealed
                          ? "Values are currently visible"
                          : "Values are masked. Saving is disabled until you reveal them."
                      }
                    >
                      {revealed ? "values visible" : "values hidden"}
                    </span>
                  )}
                  {dirty && (
                    <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-400">
                      unsaved
                    </span>
                  )}
                  <div className="ml-auto flex flex-wrap items-center gap-2">
                    {file.path.startsWith("/@personal/") && <button disabled={dirty || mutating} title={dirty ? "Save your changes before sharing" : "Create an expiring download link"} onClick={() => setShareTarget(file.path)} className="rounded-lg border border-emerald-800 px-2.5 py-1 text-xs text-emerald-400 disabled:opacity-40">Share link</button>}
                    {file.redacted && !revealed && (
                      <button
                        onClick={() => openFile(file.path, true)}
                        className="rounded-lg border border-amber-800 px-2.5 py-1 text-xs text-amber-400 hover:bg-amber-950/40"
                      >
                        Reveal values
                      </button>
                    )}
                    <a
                      href={`/api/files?action=download&path=${encodeURIComponent(file.path)}`}
                      className="rounded-lg border border-zinc-800 px-2.5 py-1 text-xs text-zinc-400 hover:border-zinc-700"
                    >
                      Download
                    </a>
                    {file.previewAvailable && file.editable && !file.binary && (
                      <button
                        onClick={save}
                        disabled={!dirty || mutating || (file.redacted && !revealed)}
                        title={
                          file.redacted && !revealed
                            ? "Reveal values before saving"
                            : undefined
                        }
                        className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
                      >
                        Save
                      </button>
                    )}
                  </div>
                </div>

                {status && <p className="px-3 py-1.5 text-xs text-emerald-400">{status}</p>}
                <div className="flex flex-wrap gap-4 border-b border-zinc-800 px-3 py-2 text-xs text-zinc-500"><span>{bytesLabel(file.size)}</span><span>Modified {new Date(file.mtimeMs).toLocaleString()}</span></div>

                {file.mediaPreview ? <MediaPreview key={`${file.path}-${file.mtimeMs}-${file.size}`} path={file.path} name={file.name} mtimeMs={file.mtimeMs} size={file.size} media={file.mediaPreview} /> : !file.previewAvailable ? <div className="space-y-2 p-8 text-center"><Icon name={fileIcon(file.name)} className="mx-auto h-12 w-12 text-zinc-600" /><p className="text-sm text-zinc-400">This file is ready to download{file.path.startsWith("/@personal/") ? " or share" : ""}.</p><p className="text-xs text-zinc-500">Preview is available for supported pictures and videos, and small text files.</p></div> : file.binary ? (
                  <p className="p-6 text-sm text-zinc-500">Binary file — use Download.</p>
                ) : file.editable ? (
                  <div className="overflow-hidden rounded-b-xl">
                    <FileEditor
                      name={file.name}
                      value={draft}
                      onChange={(v) => {
                        setDraft(v);
                        setDirty(v !== file.content);
                        dirtyRef.current = v !== file.content;
                        setStatus(null);
                      }}
                      editable={!mutating && (!file.redacted || revealed)}
                    />
                  </div>
                ) : (
                  <pre className="deploy-log max-h-[68vh] overflow-auto p-4 text-zinc-400">
                    {file.content}
                  </pre>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
