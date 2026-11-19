import { NextResponse } from "next/server";
import { requireAuth, fail } from "@/lib/api-guard";
import { discoverProjects, getProject } from "@/lib/projects";
import { deployHistory, listActiveDeploys } from "@/lib/deploy";
import { hasBinary, hasDockerCompose } from "@/lib/exec";
import { PathError } from "@/lib/safe-path";
import { envRoots } from "@/lib/roots";
import os from "node:os";
import path from "node:path";
import { provisionProject, type ProvisionOptions } from "@/lib/provision";

export async function GET(req: Request) {
  const auth = await requireAuth(req, "projects.list");
  if ("response" in auth) return auth.response;

  const url = new URL(req.url);
  const detail = url.searchParams.get("name");

  try {
    if (detail) {
      for (const root of envRoots()) {
        const candidate = path.join(root, detail);
        try {
          return NextResponse.json({ project: getProject(candidate) });
        } catch {
          continue;
        }
      }
      return fail("project not found", 404);
    }

    const projects = discoverProjects();
    return NextResponse.json({
      projects,
      roots: envRoots(),
      active: listActiveDeploys().map((d) => ({ id: d.id, project: d.project, path: d.absPath, status: d.status })),
      history: deployHistory(10),
      capabilities: {
        git: hasBinary("git"),
        docker: hasBinary("docker"),
        dockerCompose: hasDockerCompose(),
        host: os.hostname(),
        platform: process.platform,
        uptimeSec: Math.floor(process.uptime()),
        loadavg: os.loadavg(),
        totalMem: os.totalmem(),
        freeMem: os.freemem(),
        nodeVersion: process.version,
      },
    });
  } catch (err) {
    if (err instanceof PathError) return fail(err.message, err.status);
    return fail((err as Error).message, 500);
  }
}

export async function POST(req: Request) {
  const auth = await requireAuth(req, "project.create");
  if ("response" in auth) return auth.response;
  const body = await req.json().catch(() => null);
  if (!body || typeof body.name !== "string" || typeof body.root !== "string" || typeof body.template !== "string") return fail("name, root and template are required");
  for (const field of ["repository", "branch", "image"]) {
    if (body[field] !== undefined && typeof body[field] !== "string") return fail(`invalid ${field}`);
  }
  try {
    const project = await provisionProject(body as ProvisionOptions, { user: auth.user.username, ip: auth.meta.ip });
    return NextResponse.json({ ok: true, project }, { status: 201 });
  } catch (error) { return fail((error as Error).message, error instanceof PathError ? error.status : 400); }
}
