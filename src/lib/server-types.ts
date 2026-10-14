export interface CpuCounter { id: string; total: number; idle: number; iowait: number; steal: number }
export interface NetworkCounter {
  name: string; received: number | null; sent: number | null; rxPackets: number | null; txPackets: number | null;
  errors: number | null; dropped: number | null;
}
export interface ServerSnapshot {
  sampledAt: number;
  source: "native" | "host" | "container";
  identity: { hostname: string; os: string; kernel: string; architecture: string; uptimeSec: number; bootedAt: number; serverTime: string; timezone: string; addresses: string[] };
  cpu: { model: string; logicalCores: number; availableCores: number; usagePercent: number | null; iowaitPercent: number | null; stealPercent: number | null; loadAverage: number[] | null; cores: { id: string; percent: number | null }[] };
  memory: { total: number; available: number; used: number; percent: number; cached: number | null; buffers: number | null; swapTotal: number | null; swapUsed: number | null };
  storage: { path: string; label: string; total: number; available: number; used: number; percent: number; inodeTotal: number | null; inodeUsed: number | null }[];
  diskIO: { device: string; readBytes: number; writtenBytes: number; readPerSec: number | null; writePerSec: number | null; busyPercent: number | null }[];
  network: (NetworkCounter & { addresses: string[]; mac: string | null; state: string | null; speedMbps: number | null; receivePerSec: number | null; sendPerSec: number | null })[];
  ports: { protocol: string; address: string; port: number; pid: number | null }[];
  processes: { total: number; running: number | null; blocked: number | null; entries: { pid: number; name: string; state: string; memory: number; cpuPercent: number | null }[] };
  services: { available: boolean; total: number; running: number; entries: { name: string; description: string; state: string }[] };
  docker: { available: boolean; version: string | null; host: string | null; total: number; running: number; stopped: number; entries: { id: string; name: string; image: string; state: string; status: string; ports: string; cpuPercent: number | null; memory: string | null; memoryPercent: number | null; networkIO: string | null; blockIO: string | null; pids: number | null }[] };
  runtime: { node: string; pid: number; uptimeSec: number; rss: number; heapUsed: number; heapTotal: number; memoryLimit: number | null; memoryCurrent: number | null; cpuLimit: number | null };
  history: { at: number; cpu: number | null; memory: number; receivePerSec: number | null; sendPerSec: number | null }[];
  warnings: string[];
}
