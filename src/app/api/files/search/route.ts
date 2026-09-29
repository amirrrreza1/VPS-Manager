import { NextResponse } from "next/server";
import { requireAuth, fail } from "@/lib/api-guard";
import { searchFiles } from "@/lib/files";
import { PathError } from "@/lib/safe-path";

export async function GET(req: Request) {
  const auth = await requireAuth(req, "files.search");
  if ("response" in auth) return auth.response;

  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const dir = url.searchParams.get("dir") ?? undefined;
  const content = url.searchParams.get("content") === "1";

  try {
    return NextResponse.json({
      query: q,
      results: searchFiles(q, { dir, content, limit: 60 }),
    });
  } catch (err) {
    if (err instanceof PathError) return fail(err.message, err.status);
    return fail((err as Error).message, 500);
  }
}
