import fs from "node:fs";
import { requireAuth, fail } from "@/lib/api-guard";
import { isSecretFile } from "@/lib/files";
import { detectMedia } from "@/lib/media";
import { PathError } from "@/lib/safe-path";
import { fileResponse, openDownload } from "@/lib/transfers";

export const runtime = "nodejs";

async function preview(req: Request, head = false) {
  const auth = await requireAuth(req, "files.preview");
  if ("response" in auth) return auth.response;
  const filePath = new URL(req.url).searchParams.get("path");
  if (!filePath) return fail("file path is required");
  try {
    const file = openDownload(filePath);
    let media: ReturnType<typeof detectMedia>;
    try { media = isSecretFile(file.name) ? null : detectMedia(file.fd, file.name); }
    catch (error) { fs.closeSync(file.fd); throw error; }
    if (!media) { fs.closeSync(file.fd); return fail("This file cannot be previewed. Use Download instead.", 415); }
    // If-Range validators are not supported: send the full current resource.
    const range = req.headers.has("if-range") ? null : req.headers.get("range");
    return fileResponse(file, { inline: true, mimeType: media.mimeType, range, head }, req.signal);
  } catch (error) {
    if (error instanceof PathError) return fail(error.message, error.status);
    return fail("Unable to preview this file", 500);
  }
}

export async function GET(req: Request) { return preview(req); }
export async function HEAD(req: Request) { return preview(req, true); }
