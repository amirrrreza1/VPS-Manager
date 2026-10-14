"use client";

/* eslint-disable @next/next/no-img-element -- Private originals use the authenticated preview endpoint, without a public image optimizer. */
import { useRef, useState } from "react";
import type { MediaPreview as MediaFormat } from "@/lib/media";

export function MediaPreview({ path, name, mtimeMs, size, media }: {
  path: string; name: string; mtimeMs: number; size: number; media: MediaFormat;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [actualSize, setActualSize] = useState(false);
  const [details, setDetails] = useState("");
  const player = useRef<HTMLVideoElement>(null);
  const source = `/api/files/preview?path=${encodeURIComponent(path)}&version=${mtimeMs}-${size}`;

  return <section aria-label={media.kind === "image" ? "Picture preview" : "Video preview"} className="space-y-3 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-zinc-500">{media.kind === "image" ? "Picture preview" : "Video preview"}{details && ` · ${details}`}</p>{media.kind === "image" && !failed && <button onClick={() => setActualSize(!actualSize)} className="rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-300">{actualSize ? "Fit picture" : "Actual size"}</button>}</div>
    {!loaded && !failed && <p role="status" className="text-xs text-zinc-500">{media.kind === "image" ? "Loading picture…" : "Loading video details…"}</p>}
    {failed ? <div role="alert" className="rounded-lg border border-amber-900 bg-amber-950/20 p-5 text-sm text-amber-200"><p>{media.kind === "image" ? "This picture could not be previewed." : "Your browser could not play this video. Its format or codecs may not be supported."}</p><p className="mt-2 text-xs text-zinc-400">You can still download the original file. If your session expired, sign in again and refresh.</p></div> : media.kind === "image" ? <div className="max-h-[70vh] overflow-auto rounded-lg bg-zinc-950/80 p-2">
      <img
        src={source} alt={name} decoding="async"
        className={actualSize ? "mx-auto max-w-none" : "mx-auto max-h-[65vh] max-w-full object-contain"}
        onLoad={(event) => { setLoaded(true); setDetails(`${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`); }}
        onError={() => setFailed(true)}
      />
    </div> : <div className="space-y-2">
      {/* Uploaded videos may not include a captions track. The native player exposes any embedded tracks. */}
      <video
        ref={player} src={source} controls playsInline preload="metadata" aria-label={`Play ${name}`}
        className="max-h-[65vh] w-full rounded-lg bg-black" onError={() => setFailed(true)}
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          setLoaded(true);
          if (Number.isFinite(video.duration)) {
            const seconds = Math.floor(video.duration);
            setDetails(`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} · ${video.videoWidth} × ${video.videoHeight}`);
          }
        }}
      />
      <p className="text-xs text-zinc-500">Use the player controls to play, seek, adjust volume, or enter full screen. Playback depends on your browser’s supported codecs.</p>
    </div>}
  </section>;
}
