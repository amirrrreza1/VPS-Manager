import "server-only";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MAX_UPLOAD_BYTES } from "./config";
import { assertSafeName } from "./files";
import { resolveDir, resolveFile, PathError, toDisplayPath } from "./safe-path";
import { audit } from "./audit";

export type FileVersion = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
export function fileVersion(stat: fs.Stats): FileVersion {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

export function openDownload(filePath: string) {
  const abs = resolveFile(filePath);
  if (!fs.statSync(abs).isFile()) throw new PathError("not a regular file", 400);
  // Refuse special files and a symlink swapped into the final component.
  const fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new PathError("not a regular file", 400);
    return { fd, name: path.basename(abs), path: toDisplayPath(abs), version: fileVersion(stat) };
  } catch (error) { fs.closeSync(fd); throw error; }
}

interface StreamOptions { mimeType?: string; inline?: boolean; range?: string | null; head?: boolean }

export function fileResponse(file: ReturnType<typeof openDownload>, options: StreamOptions = {}, signal?: AbortSignal): Response {
  const filename = encodeURIComponent(file.name).replace(/['()*]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
  const size = file.version.size;
  const headers = new Headers({
      "Content-Type": options.mimeType ?? "application/octet-stream",
      "Content-Disposition": `${options.inline ? "inline" : "attachment"}; filename*=UTF-8''${filename}`,
      "Content-Length": String(size),
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; sandbox; frame-ancestors 'none'",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
  });
  if (options.inline) {
    headers.set("Accept-Ranges", "bytes");
    headers.set("Cross-Origin-Resource-Policy", "same-origin");
  }
  let start = 0;
  let end = size - 1;
  let status = 200;
  if (options.range && !options.head) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(options.range.trim());
    let valid = !!match && !!(match[1] || match[2]) && size > 0;
    if (valid && match) {
      if (!match[1]) {
        const suffix = Number(match[2]);
        valid = Number.isSafeInteger(suffix) && suffix > 0;
        start = Math.max(0, size - suffix);
      } else {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : size - 1;
        valid = Number.isSafeInteger(start) && Number.isSafeInteger(end) && start < size && end >= start;
        end = Math.min(end, size - 1);
      }
    }
    if (!valid) {
      fs.closeSync(file.fd);
      headers.set("Content-Range", `bytes */${size}`);
      headers.set("Content-Length", "0");
      return new Response(null, { status: 416, headers });
    }
    status = 206;
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    headers.set("Content-Length", String(end - start + 1));
  }
  if (options.head || size === 0) {
    fs.closeSync(file.fd);
    return new Response(null, { status, headers });
  }
  const stream = fs.createReadStream("", { fd: file.fd, autoClose: true, start, end });
  const abort = () => stream.destroy();
  signal?.addEventListener("abort", abort, { once: true });
  stream.once("close", () => signal?.removeEventListener("abort", abort));
  if (signal?.aborted) stream.destroy();
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, headers });
}

export function downloadResponse(file: ReturnType<typeof openDownload>, signal?: AbortSignal): Response {
  return fileResponse(file, {}, signal);
}

export async function uploadStream(
  dirPath: string, name: string, body: ReadableStream<Uint8Array>,
  meta: { user: string; ip: string }, signal?: AbortSignal, expectedBytes?: number,
) {
  assertSafeName(name);
  const dir = resolveDir(dirPath);
  const target = path.join(dir, name);
  try { fs.lstatSync(target); throw new PathError("a file with that name already exists", 409); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (expectedBytes !== undefined && expectedBytes > MAX_UPLOAD_BYTES) throw new PathError("upload too large", 413);
  const temporary = path.join(dir, `.vpm-upload-${crypto.randomBytes(16).toString("hex")}`);
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > MAX_UPLOAD_BYTES ? new PathError("upload too large", 413) : null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(body as import("node:stream/web").ReadableStream<Uint8Array>), counter,
      fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 }), { signal },
    );
    if (expectedBytes !== undefined && expectedBytes !== bytes) throw new PathError("upload was incomplete", 400);
    // Recheck confinement after a long transfer, then publish atomically with
    // an exclusive hard link: even a racing upload cannot overwrite a file.
    if (resolveDir(dirPath) !== dir) throw new PathError("folder changed during upload", 409);
    await fs.promises.link(temporary, target);
    audit({ user: meta.user, ip: meta.ip, action: "file.upload", target: toDisplayPath(target), detail: { bytes } });
    return { path: toDisplayPath(target), bytes, backupPath: null, mtimeMs: fs.statSync(target).mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new PathError("a file with that name already exists", 409);
    throw error;
  } finally { await fs.promises.unlink(temporary).catch(() => {}); }
}
