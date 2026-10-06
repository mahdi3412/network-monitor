import { execFile } from "child_process";
import { promisify } from "util";
import net from "node:net";
import { all, initDb, run, runWithId } from "./db";
import {
  configuredNetworkRanges,
  persistedConfiguredNetworkRanges
} from "./network-ranges";
import { detectServerIpv4Ranges } from "./server-network";

const execFileAsync = promisify(execFile);
let scanning = false;

const tcpPorts = [
  { port: 445, name: "SMB" },
  { port: 139, name: "NETBIOS" },
  { port: 135, name: "RPC" },
  { port: 3389, name: "RDP" },
  { port: 5985, name: "WINRM" },
  { port: 5986, name: "WINRMS" },
  { port: 80, name: "HTTP" },
  { port: 443, name: "HTTPS" },
  { port: 22, name: "SSH" },
  { port: 9100, name: "Printer" }
];

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

  const mask = (0xffffffff << (32 - prefix)) >>> 0;
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

async function probePort(ip: string, port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };

    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));

    try {
      socket.connect(port, ip);
    } catch {
      finish(false);
    }
  });
}

async function tcpProbe(ip: string) {
  const open = await Promise.all(
    tcpPorts.map(async ({ port, name }) => ({ name, open: await probePort(ip, port) }))
  );

  const services = open.filter((item) => item.open).map((item) => item.name);

  return {
    reachable: services.length > 0,
    services,
    deviceType: services.includes("Printer")
      ? "printer"
      : services.includes("SMB") || services.includes("NETBIOS") || services.includes("RPC") ||
        services.includes("RDP") || services.includes("WINRM") || services.includes("WINRMS")
        ? "windows"
        : services.includes("SSH")
          ? "linux-or-network"
          : "unknown"
  };
}

async function windowsPingHostname(ip: string) {
  if (process.platform !== "win32") return "";
  try {
    const { stdout } = await execFileAsync(
      "ping",
      ["-a", "-n", "1", "-w", "700", ip],
      { windowsHide: true, timeout: 1400 }
    );
    const match = String(stdout || "").match(/Pinging\s+([^\s\[]+)\s+\[/i);
    const hostname = String(match?.[1] || "").trim();
    return hostname && hostname !== ip ? hostname : "";
  } catch {
    return "";
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
        const parts = line.trim().split(/\s+/);
        if (parts.length < 3 || !/^\d+\.\d+\.\d+\.\d+$/.test(parts[0])) continue;
        if (!/^[0-9a-f]{2}([-:][0-9a-f]{2}){5}$/i.test(parts[1])) continue;
        result.set(parts[0], parts[1].replace(/-/g, ":").toLowerCase());
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

async function getSmbComputerName(ip: string) {
  if (process.platform !== "win32") return "";

  try {
    const { stdout } = await execFileAsync(
      "net",
      ["view", "\\\\" + ip],
      { windowsHide: true, timeout: 3500, maxBuffer: 1024 * 1024 }
    );

    const text = String(stdout || "");
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\\\\([^\\\s]+)\s+/);
      if (match?.[1]) return match[1].trim();
    }
  } catch {}

  return "";
}

async function getWindowsSessionUser(ip: string) {
  if (process.platform !== "win32") return "";

  try {
    const { stdout } = await execFileAsync(
      "query",
      ["user", "/server:" + ip],
      { windowsHide: true, timeout: 3500, maxBuffer: 1024 * 1024 }
    );

    for (const line of String(stdout || "").split(/\r?\n/).slice(1)) {
      const match = line.trim().match(/^(\S+)\s+/);
      if (match?.[1] && !/^(USERNAME|>USERNAME)$/i.test(match[1])) return match[1].trim();
    }
  } catch {}

  return "";
}

async function getWindowsWmiIdentity(ip: string) {
  if (process.platform !== "win32") return { hostname: "", username: "" };

  try {
    const script = [
      "$ErrorActionPreference='Stop'",
      "$c=Get-WmiObject -Class Win32_ComputerSystem -ComputerName '" + ip + "' -ErrorAction Stop",
      "[pscustomobject]@{Name=$c.Name;UserName=$c.UserName}|ConvertTo-Json -Compress"
    ].join(";");

    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 }
    );

    const parsed = JSON.parse(String(stdout || "").trim() || "{}");
    return {
      hostname: String(parsed.Name || "").trim(),
      username: String(parsed.UserName || "").trim()
    };
  } catch {
    return { hostname: "", username: "" };
  }
}

async function getWindowsCimIdentity(ip: string) {
  if (process.platform !== "win32") return { hostname: "", username: "" };

  try {
    const script = [
      "$ErrorActionPreference='Stop'",
      "$c=Get-CimInstance -ClassName Win32_ComputerSystem -ComputerName '" + ip + "' -OperationTimeoutSec 3",
      "[pscustomobject]@{Name=$c.Name;UserName=$c.UserName}|ConvertTo-Json -Compress"
    ].join(";");

    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 }
    );

    const parsed = JSON.parse(String(stdout || "").trim() || "{}");
    return {
      hostname: String(parsed.Name || "").trim(),
      username: String(parsed.UserName || "").trim()
    };
  } catch {
    return { hostname: "", username: "" };
  }
}

async function getNetbiosIdentity(ip: string) {
  if (process.platform !== "win32") return { hostname: "", username: "", mac: "" };

  try {
    const { stdout } = await execFileAsync("nbtstat", ["-A", ip], {
      windowsHide: true,
      timeout: 3000,
      maxBuffer: 1024 * 1024
    });

    let hostname = "";
    let netbiosServerName = "";
    let username = "";
    let mac = "";

    for (const line of String(stdout || "").split(/\r?\n/)) {
      const macMatch = line.match(/MAC\s+Address\s*=\s*([0-9a-f]{2}(?:[-:][0-9a-f]{2}){5})/i);
      if (macMatch?.[1]) mac = macMatch[1].replace(/-/g, ":").toLowerCase();
      const match = line.trim().match(/^(\S+)\s+<([0-9a-f]{2})>\s+(UNIQUE|GROUP)\b/i);
      if (!match) continue;

      const name = match[1].trim();
      const suffix = match[2].toLowerCase();
      const kind = match[3].toUpperCase();

      if (!hostname && suffix === "00" && kind === "UNIQUE") hostname = name;
      // Some Windows hosts do not expose the workstation <00> record through
      // remote NBT, while the server-service <20> record is still available.
      // Use that as a hostname fallback; <20> UNIQUE is the computer name,
      // whereas GROUP records can be a domain/workgroup name.
      if (!netbiosServerName && suffix === "20" && kind === "UNIQUE") {
        netbiosServerName = name;
      }
      if (!username && suffix === "03" && kind === "UNIQUE") username = name;
    }

    return { hostname: hostname || netbiosServerName, username, mac };
  } catch {
    return { hostname: "", username: "", mac: "" };
  }
}

async function enrichIdentities(hosts: Array<{
  ip: string;
  latencyMs: number | null;
  hostname: string;
  services: string[];
  deviceType: string;
  method: string;
  identityDiagnostics?: Record<string, string>;
}>, arp: Map<string, string>, directoryByIp: Map<string, { hostname: string; dnsHostName: string }>) {
  const enriched = [];

  for (let index = 0; index < hosts.length; index += 16) {
    const batch = hosts.slice(index, index + 16);
    const batchResults = await Promise.all(
      batch.map(async (host) => {
        const netbios = await getNetbiosIdentity(host.ip);
        const windowsReachable =
          host.services.includes("SMB") || host.services.includes("NETBIOS") ||
          host.services.includes("RPC") || host.services.includes("RDP") ||
          host.services.includes("WINRM") || host.services.includes("WINRMS");

        const shouldTryWmi =
          process.platform === "win32" &&
          (!netbios.hostname || !netbios.username) &&
          (host.services.includes("RPC") || host.services.includes("SMB") || host.services.includes("RDP"));
        const shouldTryCim =
          process.platform === "win32" &&
          (!netbios.hostname || !netbios.username) &&
          (host.services.includes("WINRM") || host.services.includes("WINRMS"));
        const shouldTrySmbName =
          process.platform === "win32" &&
          windowsReachable &&
          !netbios.hostname;
        const shouldTrySessionUser =
          process.platform === "win32" &&
          windowsReachable &&
          !netbios.username;

        const [wmi, cim, smbName, sessionUser] = await Promise.all([
          shouldTryWmi ? getWindowsWmiIdentity(host.ip) : Promise.resolve({ hostname: "", username: "" }),
          shouldTryCim ? getWindowsCimIdentity(host.ip) : Promise.resolve({ hostname: "", username: "" }),
          shouldTrySmbName ? getSmbComputerName(host.ip) : Promise.resolve(""),
          shouldTrySessionUser ? getWindowsSessionUser(host.ip) : Promise.resolve("")
        ]);

        const identityDiagnostics = {
          ...(host.identityDiagnostics || {}),
          netbios: netbios.hostname || netbios.username ? "success" : "none",
          wmi: shouldTryWmi ? (wmi.hostname || wmi.username ? "success" : "none") : "skipped",
          cim: shouldTryCim ? (cim.hostname || cim.username ? "success" : "none") : "skipped",
          smb: shouldTrySmbName ? (smbName ? "success" : "none") : "skipped",
          queryUser: shouldTrySessionUser ? (sessionUser ? "success" : "none") : "skipped",
          arp: arp.has(host.ip) ? "success" : "none",
          directoryIp: directoryByIp.has(host.ip) ? "success" : "none",
          windowsEvidence: windowsReachable ? "success" : "none"
        };

        return {
          ip: host.ip,
          latencyMs: host.latencyMs,
          hostname: host.hostname || netbios.hostname || wmi.hostname || cim.hostname || smbName || directoryByIp.get(host.ip)?.hostname || directoryByIp.get(host.ip)?.dnsHostName?.split(".")[0] || "",
          username: netbios.username || wmi.username || cim.username || sessionUser,
          mac: arp.get(host.ip) || netbios.mac || "",
          services: host.services,
          deviceType: host.deviceType === "unknown" && (windowsReachable || wmi.hostname || cim.hostname) ? "windows" : host.deviceType,
          method: directoryByIp.has(host.ip) && !(host.hostname || netbios.hostname || wmi.hostname || cim.hostname || smbName) ? `${host.method}+ad-ip` : host.method,
          identityDiagnostics: JSON.stringify(identityDiagnostics)
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

    // AD sync already stores authoritative computer/IP associations. Use them
    // as a final identity fallback when endpoint-side discovery is blocked.
    // This is strictly IP -> AD computer identity; username/MAC are not used
    // to infer a computer.
    const directoryByIp = new Map<string, { hostname: string; dnsHostName: string }>();
    try {
      const directoryRows = await all<any>("SELECT name,dns_host_name,ipv4_address FROM directory_computers WHERE trim(ipv4_address)<>''");
      for (const row of directoryRows) {
        const ip = String(row?.ipv4_address || "").trim();
        if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) continue;
        const hostname = String(row?.name || "").trim();
        const dnsHostName = String(row?.dns_host_name || "").trim();
        if (ip && (hostname || dnsHostName) && !directoryByIp.has(ip)) {
          directoryByIp.set(ip, { hostname, dnsHostName });
        }
      }
    } catch {}

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
    const initialArp = await getArpTable();

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

      for (let index = 0; index < ips.length; index += 32) {
        const batch = ips.slice(index, index + 32);
        const pingResults = await Promise.all(
          batch.map(async (ip) => ({ ip, latencyMs: await ping(ip) }))
        );

        const candidates: Array<{
          ip: string;
          latencyMs: number | null;
          hostname: string;
          services: string[];
          deviceType: string;
          method: string;
          identityDiagnostics?: Record<string, string>;
        }> = pingResults
          .filter((result) => result.latencyMs != null)
          .map((result) => ({
            ip: result.ip,
            latencyMs: result.latencyMs,
            hostname: "",
            services: [],
            deviceType: "unknown",
            method: "icmp"
          }));

        // ICMP-reachable hosts used to skip TCP probing entirely. That left
        // Windows hosts with an empty service list, so SMB/RPC/WMI/NetBIOS
        // identity enrichment was skipped even though the endpoint was online.
        // Probe all live candidates; TCP probing is also useful for classifying
        // ping-responsive Windows machines before identity enrichment.
        const liveIps = candidates.map((candidate) => candidate.ip);
        const tcpResults = await Promise.all(
          liveIps.map(async (ip) => ({ ip, ...await tcpProbe(ip) }))
        );

        for (const result of tcpResults) {
          const existing = candidates.find((candidate) => candidate.ip === result.ip);
          if (existing) {
            if (result.services.length) {
              existing.services = result.services;
              existing.deviceType = result.deviceType;
            }
          } else if (result.reachable) {
            candidates.push({
              ip: result.ip,
              latencyMs: null,
              hostname: "",
              services: result.services,
              deviceType: result.deviceType,
              method: "tcp"
            });
          }
        }

        if (!candidates.length) continue;

        const withDns = await Promise.all(
          candidates.map(async (result) => {
            const reverse = await reverseDns(result.ip);
            const pingHostname = reverse ? "" : await windowsPingHostname(result.ip);
            const pingA = reverse ? "skipped" : (pingHostname ? "success" : "none");
            const hostname = reverse || pingHostname;
            return {
              ...result,
              hostname,
              identityDiagnostics: {
                reverseDns: reverse ? "success" : "none",
                pingA
              }
            };
          })
        );

        // Ping/TCP probes above can populate the Windows neighbor/ARP cache.
        // Refresh it after probing instead of relying only on the table captured
        // before the scan started. This is especially important for routed
        // subnets such as 102/104/106.
        const refreshedArp = await getArpTable();
        const arp = new Map(initialArp);
        for (const [ip, mac] of refreshedArp) arp.set(ip, mac);
        const enriched = await enrichIdentities(withDns, arp, directoryByIp);

        for (const result of enriched) {
          await run(
            "INSERT INTO network_hosts(agent_id,ip,hostname,username,mac,adapter,subnet,method,identity_diagnostics,device_type,services,latency_ms,reachable,scanned_at,first_seen,last_seen) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(agent_id,ip) DO UPDATE SET hostname=CASE WHEN excluded.hostname<>'' THEN excluded.hostname ELSE network_hosts.hostname END,username=CASE WHEN excluded.username<>'' THEN excluded.username ELSE network_hosts.username END,mac=CASE WHEN excluded.mac<>'' THEN excluded.mac ELSE network_hosts.mac END,subnet=excluded.subnet,method=excluded.method,identity_diagnostics=excluded.identity_diagnostics,device_type=CASE WHEN excluded.device_type<>'unknown' THEN excluded.device_type ELSE network_hosts.device_type END,services=CASE WHEN excluded.services<>'[]' THEN excluded.services ELSE network_hosts.services END,latency_ms=excluded.latency_ms,reachable=1,scanned_at=excluded.scanned_at,last_seen=excluded.last_seen",
            [
              "__server__",
              result.ip,
              result.hostname,
              result.username,
              result.mac,
              "server",
              subnet,
              result.method,
              result.identityDiagnostics,
              result.deviceType,
              JSON.stringify(result.services),
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
