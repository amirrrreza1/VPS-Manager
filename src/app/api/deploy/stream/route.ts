import { requireAuth } from "@/lib/api-guard";
import { deployEvents, getDeploy, type DeployState } from "@/lib/deploy";

/** Server-sent events stream of a single deploy, for live log tailing. */

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireAuth(req, "deploy.stream");
  if ("response" in auth) return auth.response;

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return new Response("id required", { status: 400 });

  const initial = getDeploy(id);
  if (!initial) return new Response("deploy not found", { status: 404 });

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          cleanup();
        }
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        deployEvents.off(`update:${id}`, onUpdate);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const onUpdate = (state: DeployState) => {
        send("deploy", state);
        if (state.status !== "running" && state.status !== "queued") {
          // Give the client a beat to render the final frame, then close.
          setTimeout(cleanup, 500);
        }
      };

      deployEvents.on(`update:${id}`, onUpdate);
      const ping = setInterval(() => send("ping", { t: Date.now() }), 15_000);

      req.signal.addEventListener("abort", cleanup);

      send("deploy", initial);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
