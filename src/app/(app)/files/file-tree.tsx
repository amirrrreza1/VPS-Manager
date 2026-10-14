"use client";

import { useEffect, useState } from "react";
import { fileIcon, Icon } from "./file-icon";
import { bytesLabel } from "./upload-panel";

export interface Entry {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  mtimeMs: number;
  escaping?: boolean;
  broken?: boolean;
}

interface TreeProps {
  entries: Entry[] | null;
  rootPath: string;
  selectedDirectory: string;
  selectedFile?: string;
  revision: number;
  mutating: boolean;
  onDirectorySelect: (path: string) => void;
  onFileSelect: (path: string) => void;
  onRename: (path: string, name: string) => void;
  onDelete: (path: string) => void;
}

export function FileTree(props: TreeProps) {
  return <ul aria-label="Files and folders" className="w-full min-w-0 py-1">
    {props.entries === null ? <li className="px-4 py-3 text-xs text-zinc-500">Loading files…</li> : props.entries.length === 0 ? <li className="px-4 py-3 text-xs text-zinc-500">This folder is empty.</li> : props.entries.map((entry) => <TreeEntry key={entry.name} {...props} entry={entry} parentPath={props.rootPath} depth={0} />)}
  </ul>;
}

function TreeEntry(props: TreeProps & { entry: Entry; parentPath: string; depth: number }) {
  const { entry, parentPath, depth } = props;
  const full = `${parentPath === "/" ? "" : parentPath}/${entry.name}`;
  const directory = entry.type === "dir";
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const unavailable = entry.escaping || entry.broken || entry.type === "other";
  const active = directory ? props.selectedDirectory === full : props.selectedFile === full;

  useEffect(() => {
    if (!directory || !expanded) return;
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(`/api/files?path=${encodeURIComponent(full)}`, { signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(response.status === 401 ? "Session expired. Please sign in again." : data.error ?? "Could not open folder");
        if (!controller.signal.aborted) { setChildren(data.entries); setError(null); }
      } catch (cause) {
        if (!controller.signal.aborted) setError((cause as Error).message);
      }
    }
    void load();
    return () => controller.abort();
  }, [directory, expanded, full, props.revision, retry]);

  return <li>
    <div className={`group flex items-center gap-1 pr-2 ${active ? "bg-emerald-500/10" : "hover:bg-zinc-800/50"}`} style={{ paddingLeft: depth * 16 + 8 }}>
      <button
        type="button"
        title={unavailable ? entry.broken ? "Broken link" : "Unavailable outside the allowed folders" : full}
        aria-expanded={directory ? expanded : undefined}
        aria-label={directory ? `${expanded ? "Collapse" : "Expand"} ${entry.name}` : `Open ${entry.name}`}
        disabled={unavailable}
        onClick={() => {
          if (directory) { setExpanded(!expanded); props.onDirectorySelect(full); }
          else props.onFileSelect(full);
        }}
        className={`flex min-w-0 flex-1 items-center gap-2 rounded py-2 pr-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-40 ${active ? "text-emerald-300" : "text-zinc-300"}`}
      >
        {directory ? <Icon name="chevron" className={`h-3 w-3 transition-transform ${expanded ? "rotate-90" : ""}`} /> : <span className="w-3 shrink-0" />}
        <Icon name={unavailable ? "warning" : directory ? expanded ? "folderOpen" : "folder" : entry.type === "symlink" ? "link" : fileIcon(entry.name)} className={`h-[18px] w-[18px] ${directory ? "text-amber-400" : unavailable ? "text-amber-500" : "text-zinc-400"}`} />
        <span className="max-w-64 truncate">{entry.name}</span>
      </button>
      {!directory && !unavailable && <><span title={new Date(entry.mtimeMs).toLocaleString()} className="hidden text-[10px] text-zinc-500 sm:inline">{bytesLabel(entry.size)}</span><a aria-label={`Download ${entry.name}`} title={`Download ${entry.name}`} href={`/api/files?action=download&path=${encodeURIComponent(full)}`} className="rounded p-1.5 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-200"><Icon name="download" className="h-3.5 w-3.5" /></a></>}
      {!unavailable && entry.type !== "symlink" && <div className="flex shrink-0 items-center opacity-70 group-hover:opacity-100 group-focus-within:opacity-100">
        <button type="button" aria-label={`Rename ${entry.name}`} title={`Rename ${entry.name}`} disabled={props.mutating} onClick={() => props.onRename(full, entry.name)} className="rounded p-1.5 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-200 focus-visible:text-zinc-200 disabled:opacity-30"><Icon name="rename" className="h-3.5 w-3.5" /></button>
        <button type="button" aria-label={`Delete ${entry.name}`} title={`Delete ${entry.name}`} disabled={props.mutating} onClick={() => props.onDelete(full)} className="rounded p-1.5 text-zinc-500 hover:bg-red-500/10 hover:text-red-400 focus-visible:text-red-400 disabled:opacity-30"><Icon name="delete" className="h-3.5 w-3.5" /></button>
      </div>}
    </div>
    {directory && <ul hidden={!expanded} aria-label={`${entry.name} contents`}>
      {error ? <li className="py-2 pr-3 text-xs text-red-300" style={{ paddingLeft: (depth + 1) * 16 + 28 }}>{error} <button type="button" onClick={() => setRetry(retry + 1)} className="underline">Retry</button></li> : children === null ? <li role="status" className="py-2 text-xs text-zinc-500" style={{ paddingLeft: (depth + 1) * 16 + 28 }}>Loading…</li> : children.length === 0 ? <li className="py-2 text-xs text-zinc-500" style={{ paddingLeft: (depth + 1) * 16 + 28 }}>Empty folder</li> : children.map((child) => <TreeEntry key={child.name} {...props} entry={child} parentPath={full} depth={depth + 1} />)}
    </ul>}
  </li>;
}
