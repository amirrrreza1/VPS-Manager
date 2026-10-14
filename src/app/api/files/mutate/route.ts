import { NextResponse } from "next/server";
import { requireAuth, fail } from "@/lib/api-guard";
import {
  writeFileSafe,
  createFile,
  createDirectory,
  renameEntry,
  deleteEntry,
  uploadFile,
} from "@/lib/files";
import { PathError } from "@/lib/safe-path";
import { MAX_EDIT_BYTES, MAX_MULTIPART_UPLOAD_BYTES as MAX_UPLOAD_BYTES } from "@/lib/config";

interface OpArgs {
  path: string;
  dir: string;
  name: string;
  content: string;
  data: Buffer;
  user: string;
  ip: string;
  expectedMtimeMs?: number;
}

const OPS = {
  write: (b: OpArgs) => writeFileSafe(b.path, b.content, { user: b.user, ip: b.ip }, b.expectedMtimeMs),
  createFile: (b: OpArgs) => createFile(b.dir, b.name, b.content, { user: b.user, ip: b.ip }),
  createDir: (b: OpArgs) => createDirectory(b.dir, b.name, { user: b.user, ip: b.ip }),
  rename: (b: OpArgs) => renameEntry(b.path, b.name, { user: b.user, ip: b.ip }),
  delete: (b: OpArgs) => deleteEntry(b.path, { user: b.user, ip: b.ip }),
  upload: (b: OpArgs) => uploadFile(b.dir, b.name, b.data, { user: b.user, ip: b.ip }),
} as const;

type Op = keyof typeof OPS;

function mutationError(error: unknown) {
  if (error instanceof PathError) return fail(error.message, error.status);
  const cause = error as NodeJS.ErrnoException;
  if (cause.code === "EACCES" || cause.code === "EPERM") {
    return fail("Filesystem permission denied. The manager needs write access to this folder and its parent to change files or rename folders.", 403);
  }
  return fail(cause.message ?? "File operation failed", 500);
}

export async function POST(req: Request) {
  const auth = await requireAuth(req, "files.mutate");
  if ("response" in auth) return auth.response;

  if (req.headers.get("content-type")?.startsWith("multipart/form-data")) {
    const length = Number(req.headers.get("content-length") ?? 0);
    if (length > MAX_UPLOAD_BYTES + 65536) return fail("upload too large", 413);
    try {
      // Bound streamed uploads even when Content-Length is omitted.
      if (!req.body) return fail("upload body is required");
      const reader = req.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_UPLOAD_BYTES + 65536) { await reader.cancel(); return fail("upload too large", 413); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const form = await new Response(Buffer.concat(chunks), { headers: { "Content-Type": req.headers.get("content-type")! } }).formData();
      const file = form.get("file");
      const dir = form.get("dir");
      if (!(file instanceof File) || typeof dir !== "string") return fail("file and directory are required");
      if (file.size > MAX_UPLOAD_BYTES) return fail("upload too large", 413);
      const result = uploadFile(dir, file.name, Buffer.from(await file.arrayBuffer()), { user: auth.user.username, ip: auth.meta.ip });
      return NextResponse.json({ ok: true, ...result });
    } catch (err) {
      return mutationError(err);
    }
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return fail("invalid request");

  const op = body.op as Op;
  if (!op || !Object.hasOwn(OPS, op)) return fail(`unknown operation: ${String(op)}`);
  if (body.expectedMtimeMs !== undefined && (typeof body.expectedMtimeMs !== "number" || !Number.isFinite(body.expectedMtimeMs))) return fail("invalid file version");

  // Size guard before any work happens.
  if (op === "write" || op === "createFile") {
    const content = String(body.content ?? "");
    if (Buffer.byteLength(content, "utf8") > MAX_EDIT_BYTES) {
      return fail("content exceeds the edit size limit", 413);
    }
  }
  if (op === "upload") {
    const data = body.data as Buffer | undefined;
    if (!Buffer.isBuffer(data)) return fail("upload requires binary data");
    if (data.length > MAX_UPLOAD_BYTES) return fail("upload too large", 413);
  }

  try {
    const args: OpArgs = {
      path: String(body.path ?? ""),
      dir: String(body.dir ?? ""),
      name: String(body.name ?? ""),
      content: String(body.content ?? ""),
      data: body.data as Buffer,
      user: auth.user.username,
      ip: auth.meta.ip,
      expectedMtimeMs: body.expectedMtimeMs as number | undefined,
    };
    const result = OPS[op](args);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return mutationError(err);
  }
}
