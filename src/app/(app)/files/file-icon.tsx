type IconName = "folder" | "folderOpen" | "file" | "code" | "config" | "image" | "video" | "lock" | "link" | "warning" | "chevron" | "rename" | "delete" | "refresh" | "upload" | "download" | "plus" | "up";

const paths: Record<IconName, string> = {
  folder: "M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
  folderOpen: "M3 12V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v3M3 12h19l-3 8H5Z",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8ZM14 2v6h6M8 13h8M8 17h5",
  code: "M8 8 3 12l5 4M16 8l5 4-5 4M14 4l-4 16",
  config: "M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6",
  image: "M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM3 17l6-6 4 4 3-3 5 5M8 7h.01",
  video: "M4 4h16v16H4ZM4 8h16M4 16h16M8 4v4M16 4v4M8 16v4M16 16v4m-6-6 4-2-4-2Z",
  lock: "M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5ZM12 15v2",
  link: "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2",
  warning: "m12 3 10 18H2ZM12 9v4M12 17h.01",
  chevron: "m9 5 7 7-7 7",
  rename: "m15 4 5 5M4 20l4-1L20 7a2 2 0 0 0-4-4L4 15ZM4 15l5 5",
  delete: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
  refresh: "M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1",
  upload: "M12 16V3M7 8l5-5 5 5M4 16v5h16v-5",
  download: "M12 3v13M7 11l5 5 5-5M4 16v5h16v-5",
  plus: "M12 5v14M5 12h14",
  up: "M12 19V5M5 12l7-7 7 7",
};

export function Icon({ name, className = "h-4 w-4" }: { name: IconName; className?: string }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 ${className}`}><path d={paths[name]} /></svg>;
}

export function fileIcon(name: string): IconName {
  if (/^(\.env(?:\.|$)|credentials\.|id_(rsa|ed25519))|\.(pem|key|p12)$/i.test(name)) return "lock";
  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|sh|html|css|sql)$/i.test(name)) return "code";
  if (/\.(json|jsonc|ya?ml|toml|ini|conf)$|^(Dockerfile|Caddyfile|Makefile)$/i.test(name)) return "config";
  if (/\.(png|jpe?g|gif|webp|svg|ico|avif|bmp|heic|tiff?)$/i.test(name)) return "image";
  if (/\.(mp4|m4v|mov|webm|ogv|mkv|avi)$/i.test(name)) return "video";
  return "file";
}
