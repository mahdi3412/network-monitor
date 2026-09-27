import { execFile } from "child_process";
import { promisify } from "util";
import { all, initDb, run } from "./db";
import { configuredNetworkRanges } from "./network-ranges";
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
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || prefix < 1 || prefix > 30) return null;
  const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ipv4ToInt(ip) & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const total = broadcast - network - 1;
  if (total < 1 || total > 8192) return null;
  return { network, broadcast };
}

async function ping(ip: string) {
  const args = process.platform === "win32"
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

export async function scanServerNetworks() {
  if (scanning) return { scannedRanges: 0, discoveredHosts: 0, skippedRanges: 0 };
  scanning = true;

  try {
    await initDb();

    const detected = await detectServerIpv4Ranges();
    const configured = configuredNetworkRanges().map((range) => range.subnet);
    const ranges = Array.from(new Set([...detected, ...configured]));
    const now = new Date().toISOString();

    for (const subnet of ranges) {
      const source = configured.includes(subnet) ? "configured" : "server-route";
      await run(
        "INSERT INTO network_ranges(agent_id,subnet,source,first_seen,last_seen) VALUES(?,?,?,?,?) ON CONFLICT(agent_id,subnet) DO UPDATE SET source=excluded.source,last_seen=excluded.last_seen",
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
        const results = await Promise.all(batch.map(async (ip) => ({
          ip,
          latencyMs: await ping(ip)
        })));

        const reachable = results.filter((result) => result.latencyMs != null);
        const enriched = await Promise.all(
          reachable.map(async (result) => ({ ...result, hostname: await reverseDns(result.ip) }))
        );

        for (const result of enriched) {
          await run(
            "INSERT INTO network_hosts(agent_id,ip,hostname,mac,adapter,subnet,method,device_type,services,latency_ms,reachable,scanned_at,first_seen,last_seen) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(agent_id,ip) DO UPDATE SET hostname=CASE WHEN excluded.hostname<>'' THEN excluded.hostname ELSE network_hosts.hostname END,subnet=excluded.subnet,method='icmp',latency_ms=excluded.latency_ms,reachable=1,scanned_at=excluded.scanned_at,last_seen=excluded.last_seen",
            ["__server__", result.ip, result.hostname, "", "server", subnet, "icmp", "unknown", "[]", Math.round(result.latencyMs), 1, now, now, now]
          );
          discoveredHosts += 1;
        }
      }
    }

    return { scannedRanges: ranges.length, discoveredHosts, skippedRanges };
  } finally {
    scanning = false;
  }
}

export function serverScanStatus() {
  return { scanning };
}
