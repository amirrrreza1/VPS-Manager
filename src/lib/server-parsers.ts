import type { CpuCounter, NetworkCounter } from "./server-types";

export function parseCpuStat(text: string): CpuCounter[] {
  return text.split(/\r?\n/).filter((line) => /^cpu(?:\d+)?\s/.test(line)).map((line) => {
    const [id, ...fields] = line.trim().split(/\s+/);
    // guest/guest_nice are already included in user/nice, so count only 0..7.
    const values = fields.slice(0, 8).map(Number);
    if (values.length < 4 || values.some((value) => !Number.isFinite(value) || value < 0)) return null;
    return { id, total: values.reduce((sum, value) => sum + value, 0), idle: values[3] + (values[4] ?? 0), iowait: values[4] ?? 0, steal: values[7] ?? 0 };
  }).filter((value): value is CpuCounter => value !== null);
}

export function cpuUsage(current: CpuCounter, previous?: CpuCounter) {
  if (!previous) return { percent: null, iowait: null, steal: null };
  const total = current.total - previous.total;
  if (total <= 0 || current.idle < previous.idle) return { percent: null, iowait: null, steal: null };
  const percent = (value: number) => Math.min(100, Math.max(0, value / total * 100));
  return { percent: percent(total - (current.idle - previous.idle)), iowait: percent(current.iowait - previous.iowait), steal: percent(current.steal - previous.steal) };
}

export function parseMeminfo(text: string) {
  const values: Record<string, number> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\w+):\s+(\d+)\s*(kB)?/.exec(line);
    if (match) values[match[1]] = Number(match[2]) * (match[3] ? 1024 : 1);
  }
  if (!values.MemTotal) return null;
  const total = values.MemTotal;
  const available = Math.min(total, values.MemAvailable ?? ((values.MemFree ?? 0) + (values.Buffers ?? 0) + (values.Cached ?? 0)));
  return { total, available, used: total - available, percent: (total - available) / total * 100,
    cached: values.Cached ?? null, buffers: values.Buffers ?? null, swapTotal: values.SwapTotal ?? null,
    swapUsed: values.SwapTotal === undefined ? null : Math.max(0, values.SwapTotal - (values.SwapFree ?? 0)),
  };
}

export function parseNetworkDev(text: string): NetworkCounter[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*([A-Za-z0-9_.:@-]+):\s*(.+)$/.exec(line);
    if (!match) return [];
    const values = match[2].trim().split(/\s+/).map(Number);
    if (values.length < 16 || values.some((value) => !Number.isFinite(value) || value < 0)) return [];
    return [{ name: match[1], received: values[0], sent: values[8], rxPackets: values[1], txPackets: values[9], errors: values[2] + values[10], dropped: values[3] + values[11] }];
  });
}

export function counterRate(current: number | null, previous: number | null | undefined, elapsedSec: number): number | null {
  if (current === null || previous === null || previous === undefined || elapsedSec <= 0 || current < previous) return null;
  return (current - previous) / elapsedSec;
}

export function parseOsRelease(text: string): string | null {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return values.PRETTY_NAME || [values.NAME, values.VERSION].filter(Boolean).join(" ") || null;
}

export function parseProcessStat(text: string) {
  const start = text.indexOf("("); const end = text.lastIndexOf(")");
  if (start < 0 || end < start) return null;
  const fields = text.slice(end + 1).trim().split(/\s+/);
  const pid = Number(text.slice(0, start).trim());
  const ticks = Number(fields[11]) + Number(fields[12]);
  const started = Number(fields[19]);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(ticks) || !Number.isFinite(started)) return null;
  return { pid, name: text.slice(start + 1, end).slice(0, 120), state: fields[0], ticks, started };
}

export function parseListeningPorts(text: string, protocol: string) {
  return text.split(/\r?\n/).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (!/^\d+:$/.test(fields[0] ?? "") || (!protocol.startsWith("UDP") && fields[3] !== "0A")) return [];
    const match = /^([A-Fa-f0-9]{8}|[A-Fa-f0-9]{32}):([A-Fa-f0-9]{4})$/.exec(fields[1] ?? "");
    if (!match) return [];
    const port = parseInt(match[2], 16);
    if (port === 0) return [];
    const raw = match[1];
    const bytes = raw.match(/.{8}/g)!.map((word) => word.match(/../g)!.reverse().join("")).join("");
    const address = raw.length === 8 ? bytes.match(/../g)!.map((value) => parseInt(value, 16)).join(".")
      : /^0+$/.test(bytes) ? "::" : bytes.match(/.{4}/g)!.map((value) => parseInt(value, 16).toString(16)).join(":");
    return [{ protocol, address, port, pid: null }];
  });
}

export function parseJsonLines(text: string): Record<string, unknown>[] {
  return text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { const value = JSON.parse(line); return value && typeof value === "object" && !Array.isArray(value) ? [value] : []; }
    catch { return []; }
  });
}
