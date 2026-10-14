"use client";

import { useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import type { Extension } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { yaml } from "@codemirror/lang-yaml";
import { oneDark } from "@codemirror/theme-one-dark";

function languageFor(name: string): Extension[] {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"].includes(ext))
    return [javascript({ typescript: ext.includes("ts"), jsx: ext.includes("x") })];
  if (["json", "jsonc"].includes(ext)) return [json()];
  if (["yaml", "yml"].includes(ext)) return [yaml()];
  if (["md", "mdx"].includes(ext)) return [markdown()];
  if (["css", "scss", "less"].includes(ext)) return [css()];
  if (["html", "vue", "svg"].includes(ext)) return [html()];
  return [];
}

export default function FileEditor({ name, value, editable, onChange }: { name: string; value: string; editable: boolean; onChange: (value: string) => void }) {
  const extensions = useMemo(() => languageFor(name), [name]);
  return <CodeMirror value={value} height="68vh" theme={oneDark} extensions={extensions} onChange={onChange} editable={editable} />;
}
