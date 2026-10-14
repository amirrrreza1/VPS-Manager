import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isIP } from "node:net";
import { run } from "./exec";
import { DATA_DIR } from "./config";
import { envRoots, personalFilesRoot } from "./roots";
import { resolveDir } from "./safe-path";
import { counterRate, cpuUsage, parseCpuStat, parseJsonLines, parseListeningPorts, parseMeminfo, parseNetworkDev, parseOsRelease, parseProcessStat } from "./server-parsers";
import type { CpuCounter, NetworkCounter, ServerSnapshot } from "./server-types";

interface ProcessSample { pid: number; name: string; state: string; memory: number; ticks: number; started: number }
interface DiskSample { device: string; readBytes: number; writtenBytes: number; busyMs: number }
interface Sample { at: number; cpu: CpuCounter[]; network: NetworkCounter[]; processes: ProcessSample[]; disks: DiskSample[]; scope: string }
interface CollectorState { last?: ServerSnapshot; previous?: Sample; inFlight?: Promise<ServerSnapshot>; history: ServerSnapshot["history"] }
const runtime = globalThis as typeof globalThis & { __vpmServerInfo?: CollectorState };
const collector = runtime.__vpmServerInfo ??= { history: [] };

async function readText(file: string, limit = 64 * 1024): Promise<string> {
  try {
    const handle = await fs.promises.open(file, "r");
    try {
      const buffer = Buffer.alloc(limit);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.toString("utf8", 0, bytesRead).trim();
    } finally { await handle.close(); }
  } catch { return ""; }
}
const number = (value: unknown): number | null => {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (value === "") return null;
  const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};
const text = (value: unknown, limit = 160) => typeof value === "string" ? value.slice(0, limit) : "";
const array = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter((entry) => entry && typeof entry === "object") : [];
const percent = (value: unknown) => number(typeof value === "string" ? value.replace(/%$/, "") : value);

function commandDirectory(): string | null {
  for (const root of [...envRoots(), personalFilesRoot()]) {
    try { return resolveDir(root); } catch { /* configured root unavailable */ }
  }
  return null;
}

// This is a fixed, read-only script; no request inputs or file contents can
// supply commands. Process command lines, environment variables and secrets
// are intentionally excluded from the snapshot.
const WINDOWS_SNAPSHOT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$system = Get-CimInstance Win32_OperatingSystem
$processes = @(Get-Process | Select-Object Id,ProcessName,WorkingSet64,CPU)
$services = @(Get-CimInstance Win32_Service | Select-Object Name,DisplayName,State)
$network = @(Get-NetAdapterStatistics | Select-Object Name,ReceivedBytes,SentBytes,ReceivedPacketErrors,OutboundPacketErrors,ReceivedDiscardedPackets,OutboundDiscardedPackets)
$ports = @(Get-NetTCPConnection -State Listen | ForEach-Object { [pscustomobject]@{ Protocol='TCP'; Address=$_.LocalAddress; Port=$_.LocalPort; Pid=$_.OwningProcess } })
$ports += @(Get-NetUDPEndpoint | ForEach-Object { [pscustomobject]@{ Protocol='UDP'; Address=$_.LocalAddress; Port=$_.LocalPort; Pid=$_.OwningProcess } })
$volumes = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,Size,FreeSpace,FileSystem)
[pscustomobject]@{ Os=$system.Caption; SwapTotal=[double]$system.TotalVirtualMemorySize*1024-[double]$system.TotalVisibleMemorySize*1024; SwapUsed=([double]$system.TotalVirtualMemorySize-[double]$system.FreeVirtualMemory)*1024-([double]$system.TotalVisibleMemorySize-[double]$system.FreePhysicalMemory)*1024; Processes=$processes; Services=$services; Network=$network; Ports=$ports; Volumes=$volumes } | ConvertTo-Json -Depth 5 -Compress
`;

async function windowsSnapshot(cwd: string | null): Promise<Record<string, unknown> | null> {
  if (process.platform !== "win32" || !cwd) return null;
  try {
    const result = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SNAPSHOT], { cwd, timeoutMs: 12_000, maxBuffer: 512 * 1024 });
    return result.code === 0 ? JSON.parse(result.stdout) : null;
  } catch { return null; }
}

async function dockerSnapshot(cwd: string | null): Promise<ServerSnapshot["docker"]> {
  const empty: ServerSnapshot["docker"] = { available: false, version: null, host: null, total: 0, running: 0, stopped: 0, entries: [] };
  if (!cwd) return empty;
  const execute = async (args: string[]) => {
    try { return await run("docker", args, { cwd, timeoutMs: 7000, maxBuffer: 512 * 1024 }); } catch { return null; }
  };
  const [info, list, stats] = await Promise.all([
    execute(["info", "--format", "{{json .}}"]), execute(["ps", "--all", "--format", "{{json .}}"]),
    execute(["stats", "--no-stream", "--format", "{{json .}}"]),
  ]);
  if (list?.code !== 0) return empty;
  let engine: Record<string, unknown> = {};
  try { if (info?.code === 0) engine = JSON.parse(info.stdout); } catch { /* optional engine details */ }
  const usage = new Map((stats?.code === 0 ? parseJsonLines(stats.stdout) : []).map((row) => [text(row.ID), row]));
  const entries = parseJsonLines(list.stdout).slice(0, 200).map((row) => {
    const id = text(row.ID); const stat = usage.get(id);
    return { id, name: text(row.Names), image: text(row.Image, 300), state: text(row.State), status: text(row.Status, 300), ports: text(row.Ports, 1200),
      cpuPercent: percent(stat?.CPUPerc), memory: text(stat?.MemUsage) || null, memoryPercent: percent(stat?.MemPerc),
      networkIO: text(stat?.NetIO) || null, blockIO: text(stat?.BlockIO) || null, pids: number(stat?.PIDs),
    };
  });
  const total = number(engine.Containers) ?? entries.length; const running = number(engine.ContainersRunning) ?? entries.filter((entry) => entry.state === "running").length;
  return { available: true, version: text(engine.ServerVersion) || null, host: text(engine.Name) || null, total, running, stopped: Math.max(0, total - running), entries };
}

async function linuxProcesses(procRoot: string): Promise<{ total: number; entries: ProcessSample[] }> {
  let names: string[];
  try { names = (await fs.promises.readdir(procRoot)).filter((name) => /^\d+$/.test(name)); }
  catch { return { total: 0, entries: [] }; }
  const entries: ProcessSample[] = [];
  const bounded = names.slice(0, 4096);
  // Batches bound the open files and temporary memory on a small VPS.
  for (let offset = 0; offset < bounded.length; offset += 32) {
    const batch = await Promise.all(bounded.slice(offset, offset + 32).map(async (name) => {
      const [stat, status] = await Promise.all([readText(path.join(procRoot, name, "stat")), readText(path.join(procRoot, name, "status"))]);
      const process = parseProcessStat(stat);
      if (!process) return null;
      const rss = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
      return { ...process, memory: rss ? Number(rss[1]) * 1024 : 0 };
    }));
    for (const entry of batch) if (entry) entries.push(entry);
  }
  return { total: names.length, entries };
}

async function linuxServices(cwd: string | null, isContainer: boolean): Promise<ServerSnapshot["services"]> {
  const empty = { available: false, total: 0, running: 0, entries: [] };
  if (!cwd || isContainer || process.platform !== "linux") return empty;
  try {
    const result = await run("systemctl", ["list-units", "--type=service", "--all", "--no-pager", "--plain", "--no-legend"], { cwd, timeoutMs: 4000, maxBuffer: 256 * 1024 });
    if (result.code !== 0) return empty;
    const entries = result.stdout.split(/\r?\n/).flatMap((line) => {
      const fields = line.trim().replace(/^●\s*/, "").split(/\s+/);
      if (!fields[0]?.endsWith(".service") || fields.length < 4) return [];
      return [{ name: fields[0], description: fields.slice(4).join(" ").slice(0, 200), state: `${fields[2]} / ${fields[3]}` }];
    });
    return { available: true, total: entries.length, running: entries.filter((entry) => entry.state.startsWith("active /")).length, entries: entries.slice(0, 1000) };
  } catch { return empty; }
}

async function storageSnapshot(windows: Record<string, unknown> | null): Promise<ServerSnapshot["storage"]> {
  const volumes = array(windows?.Volumes).flatMap((volume) => {
    const total = number(volume.Size); const available = number(volume.FreeSpace);
    if (!total || available === null) return [];
    return [{ path: text(volume.DeviceID), label: text(volume.FileSystem) || "Local volume", total, available, used: total - available,
      percent: (total - available) / total * 100, inodeTotal: null, inodeUsed: null }];
  });
  if (volumes.length) return volumes;
  const locations = [...envRoots().map((root) => ({ path: path.resolve(root), label: "Project storage" })), { path: path.resolve(DATA_DIR), label: "Panel data" }, { path: personalFilesRoot(), label: "Personal files" }];
  const unique = locations.filter((location, index) => locations.findIndex((entry) => entry.path === location.path) === index);
  return (await Promise.all(unique.map(async (location) => {
    try {
      const stat = await fs.promises.statfs(location.path);
      const total = stat.blocks * stat.bsize; const available = stat.bavail * stat.bsize;
      return { ...location, total, available, used: (stat.blocks - stat.bfree) * stat.bsize, percent: total ? (stat.blocks - stat.bfree) / stat.blocks * 100 : 0,
        inodeTotal: stat.files || null, inodeUsed: stat.files ? stat.files - stat.ffree : null };
    } catch { return null; }
  }))).filter((entry): entry is ServerSnapshot["storage"][number] => entry !== null);
}

function nodeCpuCounters(): CpuCounter[] {
  const cores = os.cpus().map((cpu, index) => ({ id: `cpu${index}`, total: Object.values(cpu.times).reduce((sum, time) => sum + time, 0), idle: cpu.times.idle, iowait: 0, steal: 0 }));
  return [{ id: "cpu", total: cores.reduce((sum, cpu) => sum + cpu.total, 0), idle: cores.reduce((sum, cpu) => sum + cpu.idle, 0), iowait: 0, steal: 0 }, ...cores];
}

async function collectSnapshot(): Promise<ServerSnapshot> {
  const isLinux = process.platform === "linux";
  const isContainer = isLinux && (fs.existsSync("/.dockerenv") || /docker|containerd|kubepods|lxc/.test(await readText("/proc/1/cgroup")));
  const hostProc = path.resolve(/* turbopackIgnore: true */ process.env.VPM_HOST_PROC ?? "/host/proc");
  const hostVisible = isLinux && fs.existsSync(path.join(hostProc, "stat")) && fs.existsSync(path.join(hostProc, "meminfo"));
  const procRoot = hostVisible ? hostProc : "/proc";
  const sysRoot = hostVisible ? path.resolve(/* turbopackIgnore: true */ process.env.VPM_HOST_SYS ?? "/host/sys") : "/sys";
  const source: ServerSnapshot["source"] = hostVisible ? "host" : isContainer ? "container" : "native";
  const scope = `${process.platform}:${source}:${procRoot}`;
  const cwd = commandDirectory();
  const initialCpu = isLinux ? parseCpuStat(await readText(path.join(procRoot, "stat"))) : nodeCpuCounters();
  const [windows, docker, processList, services, meminfo, loadText, uptimeText, osText, hostName, cpuText, netText, fibText, diskText, tcp, tcp6, udp, udp6, memoryMax, memoryCurrent, cpuMax] = await Promise.all([
    windowsSnapshot(cwd), dockerSnapshot(cwd), isLinux ? linuxProcesses(procRoot) : Promise.resolve({ total: 0, entries: [] as ProcessSample[] }),
    linuxServices(cwd, isContainer), isLinux ? readText(path.join(procRoot, "meminfo")) : "", isLinux ? readText(path.join(procRoot, "loadavg")) : "",
    isLinux ? readText(path.join(procRoot, "uptime")) : "", isLinux ? readText(hostVisible ? process.env.VPM_HOST_OS_RELEASE ?? "/host/os-release" : "/etc/os-release") : "",
    hostVisible ? readText(process.env.VPM_HOST_HOSTNAME ?? "/host/hostname") : "", isLinux ? readText(path.join(procRoot, "cpuinfo"), 512 * 1024) : "",
    isLinux ? readText(path.join(procRoot, hostVisible ? "1/net/dev" : "net/dev")) : "",
    hostVisible ? readText(path.join(procRoot, "1/net/fib_trie")) : "", isLinux ? readText(path.join(procRoot, "diskstats")) : "",
    isLinux ? readText(path.join(procRoot, hostVisible ? "1/net/tcp" : "net/tcp")) : "",
    isLinux ? readText(path.join(procRoot, hostVisible ? "1/net/tcp6" : "net/tcp6")) : "",
    isLinux ? readText(path.join(procRoot, hostVisible ? "1/net/udp" : "net/udp")) : "",
    isLinux ? readText(path.join(procRoot, hostVisible ? "1/net/udp6" : "net/udp6")) : "",
    isContainer ? readText("/sys/fs/cgroup/memory.max") : "", isContainer ? readText("/sys/fs/cgroup/memory.current") : "", isContainer ? readText("/sys/fs/cgroup/cpu.max") : "",
  ]);
  const finalCpu = isLinux ? parseCpuStat(await readText(path.join(procRoot, "stat"))) : nodeCpuCounters();
  const at = Date.now();
  const previous = collector.previous?.scope === scope ? collector.previous : undefined;
  const elapsed = previous ? (at - previous.at) / 1000 : 0;
  const cpu = finalCpu.length ? finalCpu : initialCpu.length ? initialCpu : nodeCpuCounters();
  const previousCpu = previous?.cpu ?? initialCpu;
  const overall = cpu[0] ? cpuUsage(cpu[0], previousCpu[0]) : { percent: null, iowait: null, steal: null };
  const interfaces = os.networkInterfaces();
  const networkCounters = isLinux ? parseNetworkDev(netText) : array(windows?.Network).map((entry) => ({ name: text(entry.Name), received: number(entry.ReceivedBytes), sent: number(entry.SentBytes), rxPackets: null, txPackets: null,
    errors: number(entry.ReceivedPacketErrors) !== null && number(entry.OutboundPacketErrors) !== null ? Number(entry.ReceivedPacketErrors) + Number(entry.OutboundPacketErrors) : null,
    dropped: number(entry.ReceivedDiscardedPackets) !== null && number(entry.OutboundDiscardedPackets) !== null ? Number(entry.ReceivedDiscardedPackets) + Number(entry.OutboundDiscardedPackets) : null }));
  // When statistics are unavailable, still expose actual interface addresses.
  if (!networkCounters.length && !hostVisible) for (const name of Object.keys(interfaces)) networkCounters.push({ name, received: null, sent: null, rxPackets: null, txPackets: null, errors: null, dropped: null });
  const network = await Promise.all(networkCounters.slice(0, 64).map(async (entry) => {
    const old = previous?.network.find((row) => row.name === entry.name);
    const addresses = hostVisible ? [] : (interfaces[entry.name] ?? []).map((address) => address.address);
    const safeName = /^[A-Za-z0-9_.@-]+$/.test(entry.name);
    const [state, speed, mac] = isLinux && safeName ? await Promise.all([readText(path.join(sysRoot, "class/net", entry.name, "operstate")), readText(path.join(sysRoot, "class/net", entry.name, "speed")), readText(path.join(sysRoot, "class/net", entry.name, "address"))]) : ["", "", ""];
    return { ...entry, addresses, mac: mac || (!hostVisible ? interfaces[entry.name]?.find((address) => address.mac !== "00:00:00:00:00:00")?.mac : null) || null,
      state: state || null, speedMbps: number(speed), receivePerSec: counterRate(entry.received, old?.received, elapsed), sendPerSec: counterRate(entry.sent, old?.sent, elapsed) };
  }));
  const processes: ProcessSample[] = isLinux ? processList.entries : array(windows?.Processes).map((entry) => ({ pid: number(entry.Id) ?? 0, name: text(entry.ProcessName), state: "visible", memory: number(entry.WorkingSet64) ?? 0, ticks: (number(entry.CPU) ?? 0) * 1000, started: 0 })).filter((entry) => entry.pid > 0);
  const totalCpuDelta = previous && cpu[0] ? cpu[0].total - (previous.cpu[0]?.total ?? cpu[0].total) : 0;
  const previousProcesses = new Map(previous?.processes.map((entry) => [entry.pid, entry]));
  const topProcesses = processes.map((entry) => {
    const candidate = previousProcesses.get(entry.pid);
    const old = candidate?.started === entry.started && candidate.name === entry.name ? candidate : undefined;
    const usage = old && totalCpuDelta > 0 && entry.ticks >= old.ticks ? Math.min(100, (entry.ticks - old.ticks) / totalCpuDelta * 100) : null;
    return { pid: entry.pid, name: entry.name, state: entry.state, memory: entry.memory, cpuPercent: usage };
  }).sort((a, b) => (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0) || b.memory - a.memory).slice(0, 15);
  const disks: DiskSample[] = diskText.split(/\r?\n/).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (!/^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/.test(fields[2] ?? "") || fields.length < 14) return [];
    const read = number(fields[5]); const written = number(fields[9]); const busyMs = number(fields[12]);
    return read === null || written === null || busyMs === null ? [] : [{ device: fields[2], readBytes: read * 512, writtenBytes: written * 512, busyMs }];
  });
  const diskIO = disks.map((entry) => {
    const old = previous?.disks.find((row) => row.device === entry.device);
    const busy = counterRate(entry.busyMs, old?.busyMs, elapsed);
    return { device: entry.device, readBytes: entry.readBytes, writtenBytes: entry.writtenBytes, readPerSec: counterRate(entry.readBytes, old?.readBytes, elapsed), writePerSec: counterRate(entry.writtenBytes, old?.writtenBytes, elapsed), busyPercent: busy === null ? null : Math.min(100, busy / 10) };
  });
  const nativeTotal = os.totalmem(); const nativeFree = os.freemem();
  const memory = parseMeminfo(meminfo) ?? { total: nativeTotal, available: nativeFree, used: nativeTotal - nativeFree, percent: (nativeTotal - nativeFree) / nativeTotal * 100, cached: null, buffers: null, swapTotal: number(windows?.SwapTotal), swapUsed: number(windows?.SwapUsed) };
  const quota = cpuMax.split(/\s+/).map(Number);
  const runtimeMemory = process.memoryUsage();
  const runtimeInfo = { node: process.version, pid: process.pid, uptimeSec: Math.floor(process.uptime()), rss: runtimeMemory.rss, heapUsed: runtimeMemory.heapUsed, heapTotal: runtimeMemory.heapTotal, memoryLimit: number(memoryMax), memoryCurrent: number(memoryCurrent), cpuLimit: quota.length === 2 && quota[0] > 0 && quota[1] > 0 ? quota[0] / quota[1] : null };
  if (source === "container" && runtimeInfo.memoryLimit && runtimeInfo.memoryCurrent !== null && runtimeInfo.memoryLimit < memory.total) {
    memory.total = runtimeInfo.memoryLimit; memory.used = Math.min(memory.total, runtimeInfo.memoryCurrent); memory.available = memory.total - memory.used; memory.percent = memory.used / memory.total * 100; memory.cached = null; memory.buffers = null; memory.swapTotal = null; memory.swapUsed = null;
  }
  const nativeAddresses = Object.values(interfaces).flatMap((list) => (list ?? []).filter((address) => !address.internal).map((address) => address.address));
  const hostAddresses = [...fibText.matchAll(/\|--\s+([\d.]+)\s*\n\s*\/32 host LOCAL/g)].map((match) => match[1]).filter((address) => isIP(address) === 4 && !address.startsWith("127."));
  const uptime = number(uptimeText.split(/\s+/)[0]) ?? os.uptime();
  const windowsServices = array(windows?.Services).map((entry) => ({ name: text(entry.Name), description: text(entry.DisplayName, 200), state: text(entry.State) }));
  const ports = isLinux ? [...parseListeningPorts(tcp, "TCP"), ...parseListeningPorts(tcp6, "TCP6"), ...parseListeningPorts(udp, "UDP"), ...parseListeningPorts(udp6, "UDP6")]
    : array(windows?.Ports).flatMap((entry) => { const port = number(entry.Port); return port && port <= 65535 ? [{ protocol: text(entry.Protocol), address: text(entry.Address), port, pid: number(entry.Pid) }] : []; });
  const warnings: string[] = [];
  if (source === "container") warnings.push("Host telemetry is not mounted. This view reports the panel's visible environment; some kernel counters can still cover the host. Use the documented read-only host mounts for VPS monitoring.");
  if (process.platform === "win32") warnings.push("This panel is running on Windows. These are the local machine's resources; deploy the panel on your VPS to monitor that server.");
  if (process.platform === "win32" && !windows) warnings.push("Windows system inspection is unavailable. Basic CPU, memory and interface information is still shown.");
  if (!docker.available) warnings.push("Docker is unavailable or its daemon cannot be reached. Container metrics are not available.");
  if (hostVisible && !netText) warnings.push("Host network counters are not readable by the panel user.");
  if (isLinux && !meminfo) warnings.push("Memory details are unavailable; the runtime's basic memory totals are shown.");
  const totalRate = (key: "receivePerSec" | "sendPerSec") => { const values = network.filter((entry) => entry.name !== "lo" && !entry.name.toLowerCase().includes("loopback")).map((entry) => entry[key]).filter((value): value is number => value !== null); return values.length ? values.reduce((sum, value) => sum + value, 0) : null; };
  if (!previous) collector.history = [];
  collector.history.push({ at, cpu: overall.percent, memory: memory.percent, receivePerSec: totalRate("receivePerSec"), sendPerSec: totalRate("sendPerSec") });
  collector.history = collector.history.slice(-60);
  collector.previous = { at, cpu, network: networkCounters, processes, disks, scope };
  return {
    sampledAt: at, source,
    identity: { hostname: hostName || (hostVisible ? docker.host || "VPS host" : os.hostname()), os: text(windows?.Os, 250) || parseOsRelease(osText) || (hostVisible ? "Linux host (distribution unavailable)" : os.type()), kernel: os.release(), architecture: os.arch(), uptimeSec: Math.floor(uptime), bootedAt: at - uptime * 1000, serverTime: new Date(at).toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      addresses: [...new Set(hostVisible ? hostAddresses : nativeAddresses)] },
    cpu: { model: /^model name\s*:\s*(.+)$/m.exec(cpuText)?.[1] || /^Hardware\s*:\s*(.+)$/m.exec(cpuText)?.[1] || os.cpus()[0]?.model || "Unavailable", logicalCores: Math.max(0, cpu.length - 1), availableCores: os.availableParallelism(), usagePercent: overall.percent, iowaitPercent: isLinux ? overall.iowait : null, stealPercent: isLinux ? overall.steal : null,
      loadAverage: isLinux ? loadText.split(/\s+/).slice(0, 3).map(Number).filter(Number.isFinite) : process.platform === "darwin" ? os.loadavg() : null,
      cores: cpu.slice(1).map((entry) => ({ id: entry.id, percent: cpuUsage(entry, previousCpu.find((old) => old.id === entry.id)).percent })) },
    memory, storage: await storageSnapshot(windows), diskIO, network,
    ports: ports.sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol)).slice(0, 200),
    processes: { total: isLinux ? processList.total : processes.length, running: number(/^procs_running\s+(\d+)/m.exec(isLinux ? await readText(path.join(procRoot, "stat")) : "")?.[1]), blocked: number(/^procs_blocked\s+(\d+)/m.exec(isLinux ? await readText(path.join(procRoot, "stat")) : "")?.[1]), entries: topProcesses },
    services: windows ? { available: windowsServices.length > 0, total: windowsServices.length, running: windowsServices.filter((entry) => entry.state === "Running").length, entries: windowsServices.sort((a, b) => Number(b.state === "Running") - Number(a.state === "Running") || a.name.localeCompare(b.name)).slice(0, 1000) } : services,
    docker, runtime: runtimeInfo, history: [...collector.history], warnings,
  };
}

export async function getServerSnapshot(): Promise<ServerSnapshot> {
  if (collector.last && Date.now() - collector.last.sampledAt < 5000) return collector.last;
  if (collector.inFlight) return collector.inFlight;
  collector.inFlight = collectSnapshot().then((snapshot) => { collector.last = snapshot; return snapshot; }).finally(() => { collector.inFlight = undefined; });
  return collector.inFlight;
}
