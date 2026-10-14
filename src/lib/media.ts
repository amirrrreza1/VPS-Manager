import "server-only";
import fs from "node:fs";
import path from "node:path";

export interface MediaPreview { kind: "image" | "video"; mimeType: string }

const formats: Record<string, MediaPreview> = {
  ".jpg": { kind: "image", mimeType: "image/jpeg" },
  ".jpeg": { kind: "image", mimeType: "image/jpeg" },
  ".png": { kind: "image", mimeType: "image/png" },
  ".gif": { kind: "image", mimeType: "image/gif" },
  ".webp": { kind: "image", mimeType: "image/webp" },
  ".avif": { kind: "image", mimeType: "image/avif" },
  ".bmp": { kind: "image", mimeType: "image/bmp" },
  ".ico": { kind: "image", mimeType: "image/x-icon" },
  ".mp4": { kind: "video", mimeType: "video/mp4" },
  ".m4v": { kind: "video", mimeType: "video/mp4" },
  ".mov": { kind: "video", mimeType: "video/quicktime" },
  ".webm": { kind: "video", mimeType: "video/webm" },
  ".ogv": { kind: "video", mimeType: "video/ogg" },
};

// Inline responses allow only passive media with a matching file signature.
// HTML, SVG and XML always remain downloads, regardless of a renamed extension.
export function detectMedia(fd: number, name: string): MediaPreview | null {
  const format = formats[path.extname(name).toLowerCase()];
  if (!format) return null;
  const header = Buffer.alloc(4096);
  const length = fs.readSync(fd, header, 0, header.length, 0);
  const bytes = header.subarray(0, length);
  const starts = (hex: string) => bytes.subarray(0, hex.length / 2).equals(Buffer.from(hex, "hex"));
  const ascii = (start: number, end: number) => bytes.toString("ascii", start, end);
  let valid = false;
  switch (format.mimeType) {
    case "image/jpeg": valid = starts("ffd8ff"); break;
    case "image/png": valid = starts("89504e470d0a1a0a"); break;
    case "image/gif": valid = ["GIF87a", "GIF89a"].includes(ascii(0, 6)); break;
    case "image/webp": valid = ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP"; break;
    case "image/avif": valid = ascii(4, 8) === "ftyp" && /avif|avis/.test(ascii(8, Math.min(length, 64))); break;
    case "image/bmp": valid = length >= 14 && ascii(0, 2) === "BM"; break;
    case "image/x-icon": valid = starts("00000100"); break;
    case "video/mp4": case "video/quicktime": valid = length >= 12 && ascii(4, 8) === "ftyp"; break;
    case "video/webm": valid = starts("1a45dfa3") && bytes.includes(Buffer.from("webm")); break;
    case "video/ogg": valid = ascii(0, 4) === "OggS" && bytes.includes(Buffer.from("theora")); break;
  }
  return valid ? format : null;
}

/** Only call with an already confined, resolved filesystem path. */
export function inspectMedia(abs: string): MediaPreview | null {
  if (!formats[path.extname(abs).toLowerCase()]) return null;
  const fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try { return fs.fstatSync(fd).isFile() ? detectMedia(fd, path.basename(abs)) : null; }
  finally { fs.closeSync(fd); }
}
