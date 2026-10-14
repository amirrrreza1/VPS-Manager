"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ServerSnapshot } from "@/lib/server-types";

export function useServerInfo() {
  const [data, setData] = useState<ServerSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const request = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller;
    const timer = setTimeout(() => controller.abort(), 20_000);
    // State changes follow the asynchronous request rather than the effect.
    try {
      const response = await fetch("/api/server", { signal: controller.signal, cache: "no-store" });
      const snapshot = await response.json();
      if (!response.ok) throw new Error(response.status === 401 ? "Session expired. Sign in again to view server information." : snapshot.error ?? "Unable to refresh server information");
      setData(snapshot); setError(null);
    } catch (cause) {
      if (!controller.signal.aborted) setError((cause as Error).message);
      else if (request.current === controller) setError("The server took too long to respond. Try refreshing.");
    } finally { clearTimeout(timer); if (request.current === controller) { request.current = null; setRefreshing(false); } }
  }, []);

  useEffect(() => {
    // The fetch resolves before refresh updates state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 10_000);
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer); document.removeEventListener("visibilitychange", visible);
      const controller = request.current; request.current = null; controller?.abort();
    };
  }, [refresh]);

  return { data, error, refreshing, refresh: () => { setRefreshing(true); void refresh(); } };
}
