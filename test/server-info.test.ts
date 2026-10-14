import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "vpm-server-info-"));
const root = path.join(temporary, "projects"); fs.mkdirSync(root);
process.env.VPM_ROOTS = root;
process.env.VPM_DATA_DIR = path.join(temporary, "data"); fs.mkdirSync(process.env.VPM_DATA_DIR);
const parsers = await import("../src/lib/server-parsers.ts");
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log(`PASS ${name}`); }
try {
  await check("Linux CPU counters do not count guest time twice", () => {
    const parsed = parsers.parseCpuStat("cpu 100 20 30 400 10 5 5 30 60 15\ncpu0 40 10 20 200 5 2 3 20 30 10\nprocs_running 2\n");
    assert.equal(parsed.length, 2); assert.equal(parsed[0].total, 600); assert.equal(parsed[0].idle, 410);
    const usage = parsers.cpuUsage({ id: "cpu", total: 800, idle: 510, iowait: 30, steal: 50 }, parsed[0]);
    assert.equal(usage.percent, 50); assert.equal(usage.iowait, 10); assert.equal(usage.steal, 10);
    assert.equal(parsers.cpuUsage(parsed[0], parsed[0]).percent, null);
    assert.equal(parsers.cpuUsage({ ...parsed[0], total: 1 }).percent, null);
    assert.deepEqual(parsers.parseCpuStat("cpu nope invalid values\n"), []);
  });
  await check("memory uses reclaimable MemAvailable and treats missing swap honestly", () => {
    const memory = parsers.parseMeminfo("MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 700 kB\nCached: 600 kB\nBuffers: 50 kB\nSwapTotal: 500 kB\nSwapFree: 400 kB");
    assert.equal(memory?.used, 300 * 1024); assert.equal(memory?.percent, 30); assert.equal(memory?.swapUsed, 100 * 1024);
    const fallback = parsers.parseMeminfo("MemTotal: 1000 kB\nMemFree: 100 kB\nCached: 300 kB\nBuffers: 50 kB");
    assert.equal(fallback?.available, 450 * 1024); assert.equal(fallback?.swapTotal, null);
    assert.equal(parsers.parseMeminfo("invalid"), null);
  });
  await check("network rates use byte deltas and handle resets rather than negative speeds", () => {
    const row = parsers.parseNetworkDev("Inter-| Receive | Transmit\n eth0: 1000 20 1 2 0 0 0 0 3000 30 4 5 0 0 0 0\n")[0];
    assert.equal(row.received, 1000); assert.equal(row.sent, 3000); assert.equal(row.errors, 5); assert.equal(row.dropped, 7);
    assert.equal(parsers.counterRate(1000, 500, 10), 50);
    assert.equal(parsers.counterRate(100, 500, 10), null);
    assert.equal(parsers.counterRate(100, undefined, 10), null);
    assert.equal(parsers.counterRate(100, 50, 0), null);
  });
  await check("process names containing spaces and parentheses do not shift CPU fields", () => {
    const fields = Array(30).fill("0"); fields[0] = "S"; fields[11] = "25"; fields[12] = "15"; fields[19] = "12345";
    const process = parsers.parseProcessStat(`123 (name (worker) with spaces) ${fields.join(" ")}`);
    assert.equal(process?.name, "name (worker) with spaces"); assert.equal(process?.ticks, 40); assert.equal(process?.started, 12345);
    assert.equal(parsers.parseProcessStat("malformed"), null);
  });
  await check("port decoding separates TCP listeners from connections and handles IPv6", () => {
    const tcp = parsers.parseListeningPorts("0: 0100007F:0BB8 00000000:0000 0A\n1: 0100007F:1111 00000000:0000 01", "TCP");
    assert.deepEqual(tcp, [{ protocol: "TCP", address: "127.0.0.1", port: 3000, pid: null }]);
    const ipv6 = parsers.parseListeningPorts("0: 00000000000000000000000000000000:01BB 00000000000000000000000000000000:0000 0A", "TCP6");
    assert.equal(ipv6[0].address, "::"); assert.equal(ipv6[0].port, 443);
    assert.deepEqual(parsers.parseListeningPorts("invalid", "TCP"), []);
  });
  await check("OS metadata and Docker JSON are parsed as data rather than evaluated", () => {
    assert.equal(parsers.parseOsRelease('NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04 LTS"'), "Ubuntu 24.04 LTS");
    assert.equal(parsers.parseOsRelease('PRETTY_NAME="$(touch /tmp/malicious)"'), "$(touch /tmp/malicious)");
    assert.deepEqual(parsers.parseJsonLines('{"ID":"abc"}\nnot-json\n[]\nnull'), [{ ID: "abc" }]);
  });
  await check("real collection is bounded, caches simultaneous callers, and returns no process arguments", async () => {
    const { getServerSnapshot } = await import("../src/lib/server-info.ts");
    const [snapshot, duplicate] = await Promise.all([getServerSnapshot(), getServerSnapshot()]);
    assert.strictEqual(snapshot, duplicate);
    assert.ok(snapshot.sampledAt > Date.now() - 60_000); assert.ok(snapshot.cpu.logicalCores >= 1);
    assert.ok(snapshot.memory.total > 0); assert.ok(snapshot.memory.percent >= 0 && snapshot.memory.percent <= 100);
    assert.ok(snapshot.storage.length >= 1); assert.ok(snapshot.runtime.rss > 0);
    assert.ok(snapshot.processes.entries.length <= 15); assert.ok(snapshot.ports.length <= 200); assert.ok(snapshot.history.length <= 60);
    for (const entry of snapshot.processes.entries) assert.deepEqual(Object.keys(entry).sort(), ["cpuPercent", "memory", "name", "pid", "state"]);
    assert.ok(!JSON.stringify(snapshot).includes("GIT_TERMINAL_PROMPT"));
    assert.strictEqual(await getServerSnapshot(), snapshot);
    if (process.platform === "win32") assert.equal(snapshot.source, "native");
  });
  console.log(`\n${passed} server telemetry checks passed`);
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
