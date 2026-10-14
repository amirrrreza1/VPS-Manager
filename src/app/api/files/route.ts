import { NextResponse } from "next/server";
import { requireAuth, fail } from "@/lib/api-guard";
import { listDirectory, readFileSafe, isEditable, ensurePersonalStorage, fileInfo } from "@/lib/files";
import { PathError } from "@/lib/safe-path";
import { envRoots, PERSONAL_PATH } from "@/lib/roots";
import { MAX_EDIT_BYTES, MAX_UPLOAD_BYTES } from "@/lib/config";
import { openDownload, downloadResponse } from "@/lib/transfers";
import { audit } from "@/lib/audit";

export async function GET(req: Request) {
  const auth = await requireAuth(req, "files.list");
  if ("response" in auth) return auth.response;

  const url = new URL(req.url);
  const path = url.searchParams.get("path") ?? "/";
  const reveal = url.searchParams.get("reveal") === "1";

  try {
    ensurePersonalStorage();
    if (url.searchParams.get("action") === "download") {
      const f = openDownload(path);
      audit({ user: auth.user.username, action: "file.download", target: f.path, ip: auth.meta.ip });
      return downloadResponse(f, req.signal);
    }

    if (url.searchParams.get("action") === "info") return NextResponse.json(fileInfo(path));

    if (url.searchParams.get("action") === "read") {
      const f = readFileSafe(path, { reveal });
      if (reveal) audit({ user: auth.user.username, action: "file.reveal", target: path, ip: auth.meta.ip });
      return NextResponse.json({
        ...f,
        editable: isEditable(f.name),
        // reveal is only honoured for files already classified as secret, and
        // the UI makes the operator click through a warning to get here.
        revealGranted: reveal,
      });
    }

    const roots = envRoots();
    return NextResponse.json({ ...listDirectory(path), roots, personalPath: PERSONAL_PATH,
      locations: [{ path: PERSONAL_PATH, label: "Personal files" }, ...roots.map((root) => ({ path: roots.length === 1 ? "/" : root.replaceAll("\\", "/"), label: `Projects · ${root}` }))],
      limits: { uploadBytes: MAX_UPLOAD_BYTES, editBytes: MAX_EDIT_BYTES },
    });
  } catch (err) {
    if (err instanceof PathError) return fail(err.message, err.status);
    return fail((err as Error).message, 500);
  }
}
