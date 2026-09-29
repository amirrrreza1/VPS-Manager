import { NextResponse } from "next/server";
import { requireAuth, fail } from "@/lib/api-guard";
import { listDirectory, readFileSafe, readFileRaw, isEditable } from "@/lib/files";
import { PathError } from "@/lib/safe-path";

export async function GET(req: Request) {
  const auth = await requireAuth(req, "files.list");
  if ("response" in auth) return auth.response;

  const url = new URL(req.url);
  const path = url.searchParams.get("path") ?? "/";
  const reveal = url.searchParams.get("reveal") === "1";

  try {
    if (url.searchParams.get("action") === "download") {
      const f = readFileRaw(path);
      return new NextResponse(new Uint8Array(f.content), {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${f.name.replace(/"/g, "")}"`,
          "Content-Length": String(f.content.length),
        },
      });
    }

    if (url.searchParams.get("action") === "read") {
      const f = readFileSafe(path, { reveal });
      return NextResponse.json({
        ...f,
        editable: isEditable(f.name),
        // reveal is only honoured for files already classified as secret, and
        // the UI makes the operator click through a warning to get here.
        revealGranted: reveal,
      });
    }

    return NextResponse.json(listDirectory(path));
  } catch (err) {
    if (err instanceof PathError) return fail(err.message, err.status);
    return fail((err as Error).message, 500);
  }
}
