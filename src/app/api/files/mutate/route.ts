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
import { MAX_EDIT_BYTES, MAX_UPLOAD_BYTES } from "@/lib/config";

interface OpArgs {
  path: string;
  dir: string;
  name: string;
  content: string;
  data: Buffer;
  user: string;
  ip: string;
}

const OPS = {
  write: (b: OpArgs) => writeFileSafe(b.path, b.content, { user: b.user, ip: b.ip }),
  createFile: (b: OpArgs) => createFile(b.dir, b.name, b.content, { user: b.user, ip: b.ip }),
  createDir: (b: OpArgs) => createDirectory(b.dir, b.name, { user: b.user, ip: b.ip }),
  rename: (b: OpArgs) => renameEntry(b.path, b.name, { user: b.user, ip: b.ip }),
  delete: (b: OpArgs) => deleteEntry(b.path, { user: b.user, ip: b.ip }),
  upload: (b: OpArgs) => uploadFile(b.dir, b.name, b.data, { user: b.user, ip: b.ip }),
} as const;

type Op = keyof typeof OPS;

export async function POST(req: Request) {
  const auth = await requireAuth(req, "files.mutate");
  if ("response" in auth) return auth.response;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return fail("invalid request");

  const op = body.op as Op;
  if (!op || !(op in OPS)) return fail(`unknown operation: ${String(op)}`);

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
    };
    const result = OPS[op](args);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof PathError) return fail(err.message, err.status);
    return fail((err as Error).message, 500);
  }
}
