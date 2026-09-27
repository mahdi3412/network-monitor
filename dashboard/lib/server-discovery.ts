import { execFile } from "child_process";
import { promisify } from "util";
import { initDb, run, runWithId } from "./db";
import {
  configuredNetworkRanges,
  persistedConfiguredNetworkRanges
} from "./network-ranges";
import { detectServerIpv4Ranges } from "./server-network";

const execFileAsync = promisify(execFile);
let scanning = false;

function ipv4ToInt(ip: string) {
  return ip.split(".").reduce((n, octet) => (n << 8) + Number(octet), 0) >>> 0;
}

function intToIpv4(value: number) {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

function rangeToBounds(cidr: string) {
  const [ip, prefixText] = cidr.split("/");
  const prefix = Number(prefixText);

  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || prefix < 1 || prefix > 30) {
    return null;
  }

  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ipv4ToInt(ip) & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const total = broadcast - network - 1;

  if (total < 1 || total > 8192) {
    return null;
  }

  return { network, broadcast };
}

async function ping(ip: string) {
  const args =
    process.platform === "win32"
      ? ["-n", "1", "-w", "500", ip]
      : ["-c", "1", "-W", "1", ip];

  const started = Date.now();

  try {
    await execFileAsync("ping", args, {
      windowsHide: true,
      timeout: process.platform === "win32" ? 1700 : 1800
    });

    return Date.now() - started;
  } catch {
    return null;
  }
}

async function reverseDns(ip: string) {
  try {
    const { stdout } = await execFileAsync(
      process.platform === "win32" ? "nslookup" : "getent",
      process.platform === "win32" ? [ip] : ["hosts", ip],
      { windowsHide: true, timeout: 1500 }
    );

    const text = String(stdout || "").trim();

    if (process.platform === "win32") {
      const line = text.split(/\r?\n/).find((item) => /Name:\s+/i.test(item));
      return line ? line.replace(/^.*Name:\s+/i, "").trim() : "";
    }

    const parts = text.split(/\s+/);
    return parts.length > 1 ? parts[1] : "";
  } catch {
    return "";
  }
}

async function getArpTable() {
  const result = new Map<string, string>();

  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("arp", ["-a"], {
        windowsHide: true,
        timeout: 3000
      });

      for (const line of String(stdout || "").split(/\r?\n/)) {
        const match = line.trim().match(/^(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f]{2}[-:]){5}[0-9a-f]{2}\s+/i);
        if (!match) continue;

        const parts = line.trim().split(/\s+/);
        const mac = parts[1]?.replace(/-/g, ":").toLowerCase();
        if (mac) result.set(parts[0], mac);
      }
    } else {
      const { stdout } = await execFileAsync("ip", ["neigh"], { timeout: 3000 });

      for (const line of String(stdout || "").split(/\r?\n/)) {
        const match = line.match(/^(\d+\.\d+\.\d+\.\d+) .* lladdr ([0-9a-f:]{17})\b/i);
        if (match) result.set(match[1], match[2].toLowerCase());
      }
    }
  } catch {}

  return result;
}

async function getNetbiosIdentity(ip: string) {
  if (process.platform !== "win32") return { hostname: "", username: "" };

  try {
    const { stdout } = await execFileAsync("nbtstat", ["-A", ip], {
      windowsHide: true,
      timeout: 1800
    });

    let hostname = "";
    let username = "";

    for (const line of String(stdout || "").split(/\r?\n/)) {
      const match = line.trim().match(/^(\S+)\s+<([0-9a-f]{2})>\s+(UNIQUE|GROUP)\b/i);
      if (!match) continue;

      const name = match[1].trim();
      const suffix = match[2].toLowerCase();
      const kind = match[3].toUpperCase();

      if (!hostname && suffix === "00" && kind === "UNIQUE") hostname = name;
      if (!username && suffix === "03" && kind === "UNIQUE") username = name;
    }

    return { hostname, username };
  } catch {
    return { hostname: "", username: "" };
  }
}

async function enrichIdentities(
  hosts: Array<{ ip: string; latencyMs: number | null; hostname: string }>,
  arp: Map<string, string>
) {
  const enriched: Array<{
    ip: string;
    latencyMs: number;
    hostname: string;
    username: string;
    mac: string;
  }> = [];

  for (let index = 0; index < hosts.length; index += 16) {
    const batch = hosts.slice(index, index + 16);
    const batchResults = await Promise.all(
      batch.map(async (host) => {
        const netbios = await getNetbiosIdentity(host.ip);
        const hostname = host.hostname || netbios.hostname;
        return {
          ip: host.ip,
          latencyMs: Math.round(host.latencyMs as number),
          hostname,
          username: netbios.username,
          mac: arp.get(host.ip) || ""
        };
      })
    );

    enriched.push(...batchResults);
  }

  return enriched;
}

async function persistRunResult(
  runId: number,
  status: "success" | "error",
  ranges: number,
  hosts: number,
  skipped: number,
  error?: unknown
) {
  await run(
    "UPDATE network_scan_runs SET finished_at=?,status=?,scanned_ranges=?,discovered_hosts=?,skipped_ranges=?,error=? WHERE id=?",
    [
      new Date().toISOString(),
      status,
      ranges,
      hosts,
      skipped,
      error instanceof Error ? error.message : error ? String(error) : null,
      runId
    ]
  );
}

export async function scanServerNetworks() {
  if (scanning) {
    return {
      scannedRanges: 0,
      discoveredHosts: 0,
      skippedRanges: 0,
      runId: null,
      alreadyRunning: true
    };
  }

  scanning = true;
  const startedAt = new Date().toISOString();
  let runId: number | null = null;

  try {
    await initDb();

    runId = await runWithId(
      "INSERT INTO network_scan_runs(started_at,status) VALUES(?,?)",
      [startedAt, "running"]
    );

    const detected = await detectServerIpv4Ranges();
    const envConfigured = configuredNetworkRanges().map((range) => range.subnet);
    const persistedConfigured = (await persistedConfiguredNetworkRanges()).map((range) => range.subnet);
    const ranges = Array.from(new Set([...detected, ...envConfigured, ...persistedConfigured]));
    const configured = new Set([...envConfigured, ...persistedConfigured]);
    const now = new Date().toISOString();
    const arp = await getArpTable();

    for (const subnet of ranges) {
      const source = configured.has(subnet) ? "configured" : "server-route";

      await run(
        "INSERT INTO network_ranges(agent_id,subnet,source,first_seen,last_seen) VALUES(?,?,?,?,?) ON CONFLICT(agent_id,subnet) DO UPDATE SET source=CASE WHEN network_ranges.source='configured' THEN 'configured' ELSE excluded.source END,last_seen=excluded.last_seen",
        ["__server__", subnet, source, now, now]
      );
    }

    let discoveredHosts = 0;
    let skippedRanges = 0;

    for (const subnet of ranges) {
      const bounds = rangeToBounds(subnet);

      if (!bounds) {
        skippedRanges += 1;
        continue;
      }

      const ips: string[] = [];
      for (let value = bounds.network + 1; value < bounds.broadcast; value += 1) {
        ips.push(intToIpv4(value));
      }

      for (let index = 0; index < ips.length; index += 64) {
        const batch = ips.slice(index, index + 64);
        const results = await Promise.all(
          batch.map(async (ip) => ({
            ip,
            latencyMs: await ping(ip)
          }))
        );

        const reachable = results.filter((result) => result.latencyMs != null);
        if (!reachable.length) continue;

        const withDns = await Promise.all(
          reachable.map(async (result) => ({
            ...result,
            hostname: await reverseDns(result.ip)
          }))
        );

        const enriched = await enrichIdentities(withDns, arp);

        for (const result of enriched) {
          await run(
            "INSERT INTO network_hosts(agent_id,ip,hostname,username,mac,adapter,subnet,method,device_type,services,latency_ms,reachable,scanned_at,first_seen,last_seen) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(agent_id,ip) DO UPDATE SET hostname=CASE WHEN excluded.hostname<>'' THEN excluded.hostname ELSE network_hosts.hostname END,username=CASE WHEN excluded.username<>'' THEN excluded.username ELSE network_hosts.username END,mac=CASE WHEN excluded.mac<>'' THEN excluded.mac ELSE network_hosts.mac END,subnet=excluded.subnet,method='icmp',latency_ms=excluded.latency_ms,reachable=1,scanned_at=excluded.scanned_at,last_seen=excluded.last_seen",
            [
              "__server__",
              result.ip,
              result.hostname,
              result.username,
              result.mac,
              "server",
              subnet,
              "icmp",
              "unknown",
              "[]",
              result.latencyMs,
              1,
              now,
              now,
              now
            ]
          );

          discoveredHosts += 1;
        }
      }
    }

    await persistRunResult(runId, "success", ranges.length, discoveredHosts, skippedRanges);

    return {
      scannedRanges: ranges.length,
      discoveredHosts,
      skippedRanges,
      runId,
      alreadyRunning: false
    };
  } catch (error) {
    if (runId !== null) {
      await persistRunResult(runId, "error", 0, 0, 0, error).catch(() => {});
    }

    console.error("server network discovery failed", error);
    throw error;
  } finally {
    scanning = false;
  }
}

export function serverScanStatus() {
  return { scanning };
}
