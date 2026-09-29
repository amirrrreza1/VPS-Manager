"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import type { Extension } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { oneDark } from "@codemirror/theme-one-dark";

const CodeMirror = dynamic(() => import("@uiw/react-codemirror"), { ssr: false });

interface Entry {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  mtimeMs: number;
  escaping?: boolean;
  broken?: boolean;
}

interface FileContent {
  path: string;
  name: string;
  content: string;
  size: number;
  mtimeMs: number;
  redacted: boolean;
  binary: boolean;
  editable: boolean;
}

interface SearchHit {
  path: string;
  name: string;
  matches: { line: number; text: string }[];
}

function languageFor(name: string): Extension[] {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"].includes(ext))
    return [javascript({ typescript: ext.includes("ts"), jsx: ext.includes("x") })];
  if (["json", "jsonc"].includes(ext)) return [json()];
  if (["md", "mdx"].includes(ext)) return [markdown()];
  if (["css", "scss", "less"].includes(ext)) return [css()];
  if (["html", "vue", "svg"].includes(ext)) return [html()];
  return [];
}

export default function FilesPage() {
  const params = useSearchParams();
  const [cwd, setCwd] = useState<string>(params.get("path") ?? "/");
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
  const fileRef = useRef<FileContent | null>(null);

  const loadDir = useCallback(async (p: string) => {
    try {
      const res = await fetch(`/api/files?path=${encodeURIComponent(p)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setEntries(data.entries);
      setParent(data.parent);
      setCwd(data.path);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      setEntries([]);
    }
  }, []);

  const openFile = useCallback(async (p: string, reveal = false) => {
    try {
      const res = await fetch(
        `/api/files?action=read&path=${encodeURIComponent(p)}${reveal ? "&reveal=1" : ""}`,
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setFile(data);
      fileRef.current = data;
      setDraft(data.content);
      setDirty(false);
      setRevealed(reveal);
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
    void loadDir(params.get("path") ?? "/");
  }, [loadDir, params]);

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
    try {
      const res = await fetch("/api/files/mutate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "write", path: file.path, content: draft }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setStatus(
        data.backupPath
          ? `saved ${data.bytes} bytes (backup: ${data.backupPath.split("/").pop()})`
          : `saved ${data.bytes} bytes`,
      );
      setDirty(false);
    } catch (e) {
      setError((e as Error).message);
      setStatus(null);
    }
  }


  async function doSearch() {
    if (query.trim().length < 2) return;
    setSearching(true);
    try {
      const res = await fetch(
        `/api/files/search?q=${encodeURIComponent(query)}&content=1&limit=40`,
      );
      const data = await res.json();
      setResults(data.results ?? []);
    } finally {
      setSearching(false);
    }
  }

  const extensions = useMemo(
    () => (file ? languageFor(file.name) : []),
    [file],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Files</h1>
          <p className="font-mono text-xs text-zinc-500">{cwd}</p>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void doSearch();
          }}
          className="flex gap-2"
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search names + content…"
            className="w-64 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-sm outline-none focus:border-emerald-500"
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
        <p className="rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
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
              <div className="font-mono text-sm text-zinc-200">{r.name}</div>
              <div className="font-mono text-xs text-zinc-500">{r.path}</div>
              {r.matches.slice(0, 3).map((m, i) => (
                <div key={i} className="mt-1 truncate font-mono text-xs text-zinc-600">
                  {m.line}: {m.text.trim()}
                </div>
              ))}
            </button>
          ))}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          {/* ---- browser ---- */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40">
            <div className="flex items-center gap-1 border-b border-zinc-800 p-2">
              <button
                onClick={() => parent && loadDir(parent)}
                disabled={!parent}
                className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-30"
              >
                ↑ up
              </button>
              <button
                onClick={() => loadDir("/")}
                className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
              >
                root
              </button>
            </div>
            <div className="max-h-[70vh] overflow-auto p-1">
              {entries?.map((e) => {
                const full = `${cwd === "/" ? "" : cwd}/${e.name}`;
                const active = file?.path === full;
                return (
                  <button
                    key={e.name}
                    onClick={() => (e.type === "dir" ? loadDir(full) : openFile(full))}
                    className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition ${
                      active ? "bg-zinc-800 text-zinc-100" : "text-zinc-300 hover:bg-zinc-800/60"
                    }`}
                  >
                    <span className="w-4 shrink-0 text-zinc-500">
                      {e.type === "dir" ? "▸" : e.broken ? "⚠" : e.escaping ? "⚠" : "·"}
                    </span>
                    <span className="truncate">{e.name}</span>
                    {e.escaping && <span className="ml-auto text-[10px] text-amber-500">symlink</span>}
                    {e.type === "file" && (
                      <span className="ml-auto text-[10px] text-zinc-600">
                        {e.size < 1024 ? `${e.size}B` : `${(e.size / 1024).toFixed(1)}K`}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* ---- editor ---- */}
          <div className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-900/40">
            {!file ? (
              <p className="p-8 text-center text-sm text-zinc-500">
                Select a file to edit it.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 p-3">
                  <span className="font-mono text-sm text-zinc-200">{file.name}</span>
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
                  <div className="ml-auto flex items-center gap-2">
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
                    {file.editable && !file.binary && (
                      <button
                        onClick={save}
                        disabled={!dirty || (file.redacted && !revealed)}
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

                {file.binary ? (
                  <p className="p-6 text-sm text-zinc-500">Binary file — use Download.</p>
                ) : file.editable ? (
                  <div className="overflow-hidden rounded-b-xl">
                    <CodeMirror
                      value={draft}
                      height="68vh"
                      theme={oneDark}
                      extensions={extensions}
                      onChange={(v) => {
                        setDraft(v);
                        setDirty(v !== file.content);
                        setStatus(null);
                      }}
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
