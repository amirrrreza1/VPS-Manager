import { NextResponse } from "next/server";
import { requireAuth, fail } from "@/lib/api-guard";
import { uploadStream } from "@/lib/transfers";
import { PathError } from "@/lib/safe-path";
import { MAX_UPLOAD_BYTES } from "@/lib/config";
import { ensurePersonalStorage } from "@/lib/files";

export const runtime = "nodejs";

export async function POST(req: Request) {
  // This endpoint bypasses Proxy to avoid its body buffering. Authorization
  // and CSRF stay here, before any bytes are read or written to disk.
  const auth = await requireAuth(req, "files.upload");
  if ("response" in auth) return auth.response;
  const url = new URL(req.url);
  const dir = url.searchParams.get("dir");
  const name = url.searchParams.get("name");
  if (!dir || !name) return fail("file name and directory are required");
  const sizeHeader = req.headers.get("content-length");
  const size = sizeHeader === null ? undefined : Number(sizeHeader);
  if (size !== undefined && (!Number.isSafeInteger(size) || size < 0)) return fail("invalid upload size");
  if (size !== undefined && size > MAX_UPLOAD_BYTES) return fail("upload too large", 413);
  if (!req.body && size !== 0) return fail("upload body is required");
  try {
    ensurePersonalStorage();
    const body = req.body ?? new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
    const result = await uploadStream(dir, name, body, { user: auth.user.username, ip: auth.meta.ip }, req.signal, size);
    return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PathError) return fail(error.message, error.status);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return fail("Permission denied. Choose a writable folder.", 403);
    if (code === "ENOSPC" || code === "EDQUOT") return fail("The VPS has no space available for this upload.", 507);
    if ((error as Error).name === "AbortError") return fail("Upload cancelled", 400);
    return fail("Upload failed", 500);
  }
}
