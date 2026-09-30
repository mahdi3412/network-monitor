import { NextResponse } from "next/server";
import dns from "node:dns/promises";
import { all, initDb, run, transaction } from "../../../lib/db";
import { normalizeHostname, shortHostname } from "../../../lib/hostname";
import {
  getAdConfig,
  lookupAdComputer,
  lookupAdUserByPersonnel,
  syncAdComputers,
  syncAdUsers,
  testAdConnection
} from "../../../lib/ad-directory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

function json(data: unknown, status = 200) {
  return NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

function normalizeMac(value: unknown): string {
  return String(value || "").trim().toLowerCase().replace(/[^0-9a-f]/g, "");
}

function isReservedInventoryIp(value: unknown): boolean {
  const parts = String(value || "").trim().split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return false;
  const lastOctet = Number(parts[3]);
  return lastOctet >= 1 && lastOctet <= 11 || lastOctet >= 241 && lastOctet <= 254;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const test = url.searchParams.get("test") === "1";
    const personnelId = url.searchParams.get("personnelId")?.trim();
    const computerName = url.searchParams.get("computerName")?.trim();

    if (test) {
      const result = await testAdConnection();
      return json({
        ok: Boolean(result?.ok),
        config: getAdConfig(),
        result
      });
    }

    if (personnelId) {
      const user = await lookupAdUserByPersonnel(personnelId);
      return json({ ok: true, found: Boolean(user), user });
    }

    if (computerName) {
      const computer = await lookupAdComputer(computerName);
      return json({ ok: true, found: Boolean(computer), computer });
    }

    await initDb();
    const rows = await all<any>(
      "SELECT personnel_id,username,user_principal_name,display_name,first_name,last_name,department,title,email,last_sync FROM directory_users ORDER BY display_name ASC"
    );

    return json({
      ok: true,
      config: getAdConfig(),
      users: rows
    });
  } catch (error) {
    console.error("Active Directory request failed", error);
    return json({
      ok: false,
      error: error instanceof Error ? error.message : "Active Directory request failed"
    }, 500);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);

    if (body?.action === "sync-computers") {
      const computers = await syncAdComputers();
      await initDb();

      const syncTime = new Date().toISOString();
      const statements = computers
        .map((computer: any) => {
          const dnsHostName = String(computer?.dnsHostName || "").trim();
          const rawName = String(computer?.name || "").trim();
          const distinguishedName = String(computer?.distinguishedName || "").trim();
          const cnMatch = distinguishedName.match(/^CN=([^,]+)/i);
          const name = rawName || (cnMatch ? cnMatch[1].trim() : "") || dnsHostName.split(".")[0].trim();
          if (!name) return null;
          return {
            sql: "INSERT INTO directory_computers(name,dns_host_name,operating_system,operating_system_version,description,managed_by,distinguished_name,last_sync) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET dns_host_name=excluded.dns_host_name,operating_system=excluded.operating_system,operating_system_version=excluded.operating_system_version,description=excluded.description,managed_by=excluded.managed_by,distinguished_name=excluded.distinguished_name,last_sync=excluded.last_sync",
            params: [name, dnsHostName, String(computer?.operatingSystem || ""), String(computer?.operatingSystemVersion || ""), String(computer?.description || ""), String(computer?.managedBy || ""), String(computer?.distinguishedName || ""), syncTime]
          };
        })
        .filter(Boolean) as Array<{ sql: string; params: any[] }>;

      if (statements.length) await transaction(statements);

      const rawComputerSamples = computers.slice(0, 5).map((computer: any) => ({
        name: String(computer?.name || ""),
        dnsHostName: String(computer?.dnsHostName || ""),
        distinguishedName: String(computer?.distinguishedName || "")
      }));
      const [inventory, directoryComputers] = await Promise.all([
        all<any>("SELECT nh.ip, nh.hostname, nh.mac, nh.subnet, nh.device_type, nh.services, nh.method, nh.last_seen, c.hostname AS agent_hostname, c.mac AS agent_mac FROM network_hosts nh LEFT JOIN clients c ON c.agent_id = nh.agent_id"),
        all<any>("SELECT name,dns_host_name FROM directory_computers")
      ]);

      const names = new Set<string>();
      const dnsNames = new Set<string>();
      const clientByMac = new Map<string, any>();
      const clientByIp = new Map<string, any>();
      const agentAdDiagnostics = new Map<string, { ip: string; mac: string; hostname: string; adByName: string; adByIp: string }>();
      const identityConflicts = { macVsIp: 0, macVsHostname: 0 };
      const identityConflictSamples: string[] = [];

      for (const host of inventory) {
        const mac = normalizeMac(host?.agent_mac);
        const ip = String(host?.ip || "").trim();
        if (mac && host?.agent_hostname) clientByMac.set(mac, host);
        if (ip && host?.agent_hostname) clientByIp.set(ip, host);
      }
      const dnsShortNames = new Set<string>();
      const computerByDnsShort = new Map<string, any>();
      const computersByIp = new Map<string, any>();
      const adDnsIpConflicts = new Map<string, Set<string>>();
      const adComputerIpMap = new Map<string, Set<string>>();
      const computerByName = new Map<string, any>();
      const computerByDns = new Map<string, any>();

      for (const computer of directoryComputers) {
        const name = normalizeHostname(computer.name);
        const dnsHostName = normalizeHostname(computer.dns_host_name);
        if (name) {
          names.add(name);
          computerByName.set(name, computer);
        }
        if (dnsHostName) {
          dnsNames.add(dnsHostName);
          computerByDns.set(dnsHostName, computer);
          const shortDnsName = shortHostname(dnsHostName);
          if (shortDnsName) {
            dnsShortNames.add(shortDnsName);
            computerByDnsShort.set(shortDnsName, computer);
          }
        }
      }

      const adDnsResolver = new dns.Resolver();
      let adDnsServer = "";
      let adDnsServerResolved = false;
      try {
        const config = getAdConfig();
        const serverAddresses = config.server ? await dns.resolve4(config.server) : [];
        adDnsServer = serverAddresses[0] || "";
        if (adDnsServer) {
          adDnsResolver.setServers([adDnsServer]);
          adDnsServerResolved = true;
        }
      } catch {
        // Keep the system resolver as a fallback.
      }

      let adDnsWithName = 0;
      let adDnsSystemResolved = 0;
      let adDnsDirectResolved = 0;
      let adDnsUnresolved = 0;
      const adDnsResolutionSamples: string[] = [];

      // Reverse-resolve inventory IPs against the AD DNS server so hosts with
      // missing agent-side hostnames can still be matched to AD computers.
      const inventoryReverseNames = new Map<string, string[]>();
      const inventoryForwardIps = new Map<string, string[]>();
      const inventoryDnsDiagnostics: Array<{ ip: string; hostname: string; resolvedIps: string[]; adIps: string[] }> = [];
      if (adDnsServerResolved) {
        await Promise.all(inventory.map(async (host: any) => {
          const ip = String(host?.ip || "").trim();
          if (!ip || isReservedInventoryIp(ip)) return;
          try {
            const names = await adDnsResolver.reverse(ip);
            if (names.length) {
              inventoryReverseNames.set(
                ip,
                names.map(normalizeHostname).filter(Boolean)
              );
            }
          } catch {}
        }));
      }

      // Forward-resolve inventory hostnames with the system resolver to detect
      // hostname->IP mismatches independently from AD DNS matching.
      await Promise.all(inventory.map(async (host: any) => {
        const ip = String(host?.ip || "").trim();
        const hostname = normalizeHostname(host?.hostname);
        if (!ip || !hostname || isReservedInventoryIp(ip)) return;
        try {
          const addresses = await dns.resolve4(hostname);
          const resolvedIps = addresses.map((value) => String(value || "").trim()).filter(Boolean);
          if (!resolvedIps.length) return;
          inventoryForwardIps.set(ip, resolvedIps);
          if (!resolvedIps.includes(ip) && inventoryDnsDiagnostics.length < 50) {
            inventoryDnsDiagnostics.push({
              ip,
              hostname,
              resolvedIps,
              adIps: []
            });
          }
        } catch {}
      }));

      // Forward-resolve only through the normal resolver first. Direct AD DNS
      // lookups are deliberately avoided for every AD computer because a large
      // number of missing DNS records can make the sync wait on resolver timeouts.
      await Promise.all(directoryComputers.map(async (computer: any) => {
        const dnsHostName = normalizeHostname(computer.dns_host_name);
        if (!dnsHostName) return;
        adDnsWithName += 1;

        try {
          const addresses = await dns.resolve4(dnsHostName);
          if (addresses.length) {
            adDnsSystemResolved += 1;
            for (const address of addresses) {
              const ip = String(address || "").trim();
              if (!ip) continue;
              const existing = computersByIp.get(ip);
              if (existing && normalizeHostname(existing.name) !== normalizeHostname(computer.name)) {
                const set = adDnsIpConflicts.get(ip) || new Set<string>();
                set.add(String(existing.name || existing.dns_host_name || ""));
                set.add(String(computer.name || computer.dns_host_name || ""));
                adDnsIpConflicts.set(ip, set);
              }
              computersByIp.set(ip, computer);
              const computerKey = normalizeHostname(computer.name) || normalizeHostname(computer.dns_host_name);
              if (computerKey) {
                const ips = adComputerIpMap.get(computerKey) || new Set<string>();
                ips.add(ip);
                adComputerIpMap.set(computerKey, ips);
              }
            }
            if (adDnsResolutionSamples.length < 10) {
              adDnsResolutionSamples.push(`${dnsHostName} -> ${addresses.join(",")}`);
            }
            return;
          }
        } catch {}

        adDnsUnresolved += 1;
        if (adDnsResolutionSamples.length < 10) adDnsResolutionSamples.push(dnsHostName);
      }));

      for (const host of inventory) {
        const agentHostname = normalizeHostname(host?.agent_hostname);
        const agentIp = String(host?.ip || "").trim();
        const agentMac = normalizeMac(host?.agent_mac);
        const adByName = computerByName.get(shortHostname(agentHostname)) || computerByDnsShort.get(shortHostname(agentHostname));
        const adByIp = computersByIp.get(agentIp);
        const key = String(host?.agent_hostname || host?.ip || host?.agent_mac || "").trim();
        if (key && !agentAdDiagnostics.has(key)) agentAdDiagnostics.set(key, {
          ip: agentIp, mac: agentMac, hostname: String(host?.agent_hostname || ""),
          adByName: String(adByName?.name || adByName?.dns_host_name || ""),
          adByIp: String(adByIp?.name || adByIp?.dns_host_name || "")
        });
      }

      const adOsByName = new Map<string, string>();
      for (const computer of directoryComputers) {
        const key = normalizeHostname(computer.name) || shortHostname(computer.dns_host_name);
        const os = String(computer.operating_system || "").trim();
        if (key && os) adOsByName.set(key, os);
      }
      const inventoryAdOsDiagnostics = new Map<string, { total: number; matches: number; unmatched: number }>();
      const inventoryClassificationDiagnostics = new Map<string, { total: number; matches: number; unmatched: number }>();
      const windowsUnmatchedDiagnostics = new Map<string, number>();
      const windowsUnmatchedSamples: string[] = [];

      const matchedIps = new Set<string>();
      let inventoryDnsIpConflicts = 0;
      let reservedInventoryHosts = 0;
      let eligibleInventoryHosts = 0;
      let hostsWithHostname = 0;
      let hostnameMatches = 0;
      let dnsMatches = 0;
      let ipMatches = 0;
      let ipMatchConflicts = 0;
      const matchMethodCounts = { ip: 0, hostname: 0, dns: 0, macHostname: 0 };
      const matchSamples = { ip: [] as string[], hostname: [] as string[], dns: [] as string[], macHostname: [] as string[] };

      const unmatchedSamples: string[] = [];
      const unmatchedDiagnostics: string[] = [];
      const unmatchedByDeviceType: string[] = [];
      const unmatchedReasonCounts = { noHostname: 0, hostnameNotInAd: 0, dnsUnresolved: 0, ipNotResolvedInAdDns: 0, nonWindowsOrUnknown: 0 };
      const unmatchedReasonSamples = { noHostname: [] as string[], hostnameNotInAd: [] as string[], dnsUnresolved: [] as string[], ipNotResolvedInAdDns: [] as string[], nonWindowsOrUnknown: [] as string[] };
      const matchedSamples: string[] = [];
      let inventoryIpUnmatched = 0;
      const inventoryBySubnet = new Map<string, { total: number; ipMatches: number; withHostname: number }>();
      const inventoryByDeviceType = new Map<string, { total: number; ipMatches: number }>();

      for (const host of inventory) {
        const normalizedIp = String(host.ip || "").trim();
        if (isReservedInventoryIp(normalizedIp)) {
          reservedInventoryHosts += 1;
          continue;
        }
        eligibleInventoryHosts += 1;

        const subnetKey = String(host.subnet || "بدون subnet");
        const subnetStats = inventoryBySubnet.get(subnetKey) || { total: 0, ipMatches: 0, withHostname: 0 };
        subnetStats.total += 1;

        const deviceTypeKey = String(host.device_type || "unknown");
        const deviceStats = inventoryByDeviceType.get(deviceTypeKey) || { total: 0, ipMatches: 0 };
        deviceStats.total += 1;

        const hostMac = normalizeMac(host?.mac || host?.agent_mac);
        const macClient = hostMac ? clientByMac.get(hostMac) : undefined;
        const ipClient = clientByIp.get(normalizedIp);
        if (macClient && ipClient && macClient.agent_hostname !== ipClient.agent_hostname) {
          identityConflicts.macVsIp += 1;
          if (identityConflictSamples.length < 20) identityConflictSamples.push(`MAC ${hostMac} -> ${macClient.agent_hostname} / IP ${normalizedIp} -> ${ipClient.agent_hostname}`);
        }
        if (macClient?.agent_hostname && host.hostname && normalizeHostname(macClient.agent_hostname) !== normalizeHostname(host.hostname)) {
          identityConflicts.macVsHostname += 1;
          if (identityConflictSamples.length < 20) identityConflictSamples.push(`MAC ${hostMac} -> ${macClient.agent_hostname} / scan ${host.hostname}`);
        }
        const forwardIps = inventoryForwardIps.get(normalizedIp) || [];
        if (forwardIps.length && !forwardIps.includes(normalizedIp)) {
          inventoryDnsIpConflicts += 1;
          const diagnostic = inventoryDnsDiagnostics.find((item) => item.ip === normalizedIp);
          if (diagnostic) diagnostic.adIps = forwardIps;
        }

        const candidates = [
          host.hostname,
          ...(macClient?.agent_hostname ? [macClient.agent_hostname] : []),
          ...(inventoryReverseNames.get(String(host.ip || "").trim()) || [])
        ]
          .map(normalizeHostname)
          .filter(Boolean)
          .filter((value, index, values) => values.indexOf(value) === index);

        if (candidates.length) {
          hostsWithHostname += 1;
          subnetStats.withHostname += 1;
        }

        // IP matching must not depend on reverse-DNS/NBT hostname availability.
        // A host can be an AD computer even when its inventory hostname is empty.
        const ipComputer = computersByIp.get(normalizedIp);
        const ipMatch = Boolean(ipComputer);
        let hostnameMatch = false;
        let dnsMatch = false;
        const macHostnameCandidate = macClient?.agent_hostname ? normalizeHostname(macClient.agent_hostname) : "";
        let macHostnameMatch = false;
        let matchedCandidate = ipMatch ? `${host.ip} -> ${ipComputer?.name || ipComputer?.dns_host_name || ""}` : "";

        for (const candidate of candidates) {
          const shortCandidate = shortHostname(candidate);
          if (names.has(shortCandidate) || dnsShortNames.has(shortCandidate)) {
            hostnameMatch = true;
            macHostnameMatch = Boolean(macHostnameCandidate && shortCandidate === shortHostname(macHostnameCandidate));
            matchedCandidate = candidate;
            break;
          }
          if (dnsNames.has(candidate)) {
            dnsMatch = true;
            matchedCandidate = candidate;
            break;
          }
        }

        if (ipMatch && (hostnameMatch || dnsMatch)) ipMatchConflicts += 1;

        if (hostnameMatch || dnsMatch || ipMatch) {
          matchedIps.add(host.ip);
          if (ipMatch) {
            ipMatches += 1;
            subnetStats.ipMatches += 1;
            deviceStats.ipMatches += 1;
            matchMethodCounts.ip += 1;
            if (matchSamples.ip.length < 10) matchSamples.ip.push(matchedCandidate);
          } else if (hostnameMatch) {
            hostnameMatches += 1;
            if (macHostnameMatch) {
              matchMethodCounts.macHostname += 1;
              if (matchSamples.macHostname.length < 10) matchSamples.macHostname.push(`${matchedCandidate} [MAC-confirmed] -> ${host.ip}`);
            } else {
              matchMethodCounts.hostname += 1;
              if (matchSamples.hostname.length < 10) matchSamples.hostname.push(`${matchedCandidate} -> ${host.ip}`);
            }
          } else {
            dnsMatches += 1;
            matchMethodCounts.dns += 1;
            if (matchSamples.dns.length < 10) matchSamples.dns.push(`${matchedCandidate} -> ${host.ip}`);
          }
          if (matchedSamples.length < 5) matchedSamples.push(matchedCandidate);
        } else {
          inventoryIpUnmatched += 1;
          const reverseNames = inventoryReverseNames.get(normalizedIp) || [];
          const shortCandidates = candidates.map(shortHostname).filter(Boolean);
          const hasHostname = candidates.length > 0;
          const hasAdHostname = shortCandidates.some((value) => names.has(value) || dnsShortNames.has(value) || dnsNames.has(value));
          let unmatchedReason: keyof typeof unmatchedReasonCounts;
          const ipResolvedInAdDns = computersByIp.has(normalizedIp);
          const reverseResolved = reverseNames.length > 0;
          const macConfirmedHostname = macClient?.agent_hostname ? normalizeHostname(macClient.agent_hostname) : "";
          const macConfirmedAdHostname = macConfirmedHostname
            ? names.has(shortHostname(macConfirmedHostname)) || dnsShortNames.has(shortHostname(macConfirmedHostname)) || dnsNames.has(macConfirmedHostname)
            : false;

          if (!hasHostname) {
            unmatchedReason = "noHostname";
          } else if (!hasAdHostname && !macConfirmedAdHostname) {
            unmatchedReason = "hostnameNotInAd";
          } else if (adDnsServerResolved && !ipResolvedInAdDns && !reverseResolved) {
            unmatchedReason = "ipNotResolvedInAdDns";
          } else if (!reverseResolved && !ipResolvedInAdDns) {
            unmatchedReason = "dnsUnresolved";
          } else {
            unmatchedReason = "nonWindowsOrUnknown";
          }
          unmatchedReasonCounts[unmatchedReason] += 1;
          if (unmatchedReasonSamples[unmatchedReason].length < 10) unmatchedReasonSamples[unmatchedReason].push(`${normalizedIp} | ${candidates.join(",") || "-"}`);
          if (unmatchedSamples.length < 10) {
            const sample = `${host.ip} | ${candidates.join(" / ") || "بدون hostname"}`;
            if (!unmatchedSamples.includes(sample)) unmatchedSamples.push(sample);
          }
          if (unmatchedDiagnostics.length < 20) {
            const adByName = shortCandidates
              .map((value) => computerByName.get(value) || computerByDnsShort.get(value))
              .filter(Boolean)
              .map((computer) => String(computer.name || computer.dns_host_name || ""));
            const adByDns = candidates
              .map((value) => computerByDns.get(value))
              .filter(Boolean)
              .map((computer) => String(computer.name || computer.dns_host_name || ""));
            const details = [
              `IP=${normalizedIp || "-"}`,
              `host=${String(host.hostname || "-")}`,
              `reverse=${reverseNames.join(",") || "-"}`,
              `candidates=${candidates.join(",") || "-"}`,
              `AD-name=${adByName.join(",") || "-"}`,
              `AD-dns=${adByDns.join(",") || "-"}`,
              `mac=${String(host.mac || "-")}`,
              `method=${String(host.method || "-")}`,
              `type=${String(host.device_type || "-")}`
            ].join(" | ");
            if (!unmatchedDiagnostics.includes(details)) unmatchedDiagnostics.push(details);
          }
        }

        inventoryBySubnet.set(subnetKey, subnetStats);
        inventoryByDeviceType.set(deviceTypeKey, deviceStats);
        const adOsCandidate = candidates.map(shortHostname).find((value) => adOsByName.has(value));
        const adOs = adOsCandidate ? (adOsByName.get(adOsCandidate) || "").toLowerCase() : "";
        const deviceType = String(host.device_type || "unknown").trim().toLowerCase() || "unknown";
        const serviceText = String(host.services || "").toLowerCase();
        let classification = deviceType;
        if (adOs.includes("windows")) classification = "windows-ad";
        else if (deviceType === "printer" || serviceText.includes("printer")) classification = "printer";
        else if (deviceType === "linux-or-network" || serviceText.includes("ssh")) classification = "linux-network";
        else if (deviceType === "unknown") classification = adOs ? "ad-nonwindows" : "unknown";
        const hasWindowsEvidence = adOs.includes("windows") || deviceType === "windows" || serviceText.includes("microsoft") || serviceText.includes("rdp");
        const hasAdHostnameForDiagnostics = candidates
          .map(shortHostname)
          .some((value) => names.has(value) || dnsShortNames.has(value) || dnsNames.has(value));
        if (hasWindowsEvidence && !(ipMatch || hostnameMatch || dnsMatch)) {
          let reason = "outside-ad-or-unknown";
          if (host.hostname && !hasAdHostnameForDiagnostics && (forwardIps.length === 0 || !forwardIps.includes(normalizedIp))) {
            reason = "hostname-not-in-ad";
          } else if (forwardIps.length && !forwardIps.includes(normalizedIp)) {
            reason = "dns-ip-mismatch";
          } else if (adDnsServerResolved && !computersByIp.has(normalizedIp)) {
            reason = "not-resolved-in-ad-dns";
          }
          windowsUnmatchedDiagnostics.set(reason, (windowsUnmatchedDiagnostics.get(reason) || 0) + 1);
          if (windowsUnmatchedSamples.length < 30) {
            windowsUnmatchedSamples.push(`${normalizedIp} | ${host.hostname || "-"} | ${reason}`);
          }
        }
        const classStats = inventoryClassificationDiagnostics.get(classification) || { total: 0, matches: 0, unmatched: 0 };
        classStats.total += 1;
        if (ipMatch || hostnameMatch || dnsMatch) classStats.matches += 1;
        else classStats.unmatched += 1;
        inventoryClassificationDiagnostics.set(classification, classStats);

        const candidateAdName = candidates.map(shortHostname).find((value) => adOsByName.has(value));
        if (candidateAdName) {
          const os = adOsByName.get(candidateAdName) || "unknown";
          const stats = inventoryAdOsDiagnostics.get(os) || { total: 0, matches: 0, unmatched: 0 };
          stats.total += 1;
          if (ipMatch || hostnameMatch || dnsMatch) stats.matches += 1;
          else stats.unmatched += 1;
          inventoryAdOsDiagnostics.set(os, stats);
        }
      }

      const subnetDiagnostics = Array.from(inventoryBySubnet.entries())
        .map(([subnet, stats]) => ({ subnet, ...stats }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 15);
      const deviceTypeDiagnostics = Array.from(inventoryByDeviceType.entries())
        .map(([deviceType, stats]) => ({ deviceType, ...stats }))
        .sort((a, b) => b.total - a.total);

      const adComputerMultiIpDiagnostics = Array.from(adComputerIpMap.entries())
        .filter(([, ips]) => ips.size > 1)
        .sort((a, b) => b[1].size - a[1].size)
        .slice(0, 50)
        .map(([name, ips]) => ({ name, ips: Array.from(ips) }));
      const adComputerMultiIpCount = Array.from(adComputerIpMap.values()).filter((ips) => ips.size > 1).length;

      const adDnsIpConflictSamples = Array.from(adDnsIpConflicts.entries())
        .slice(0, 20)
        .map(([ip, values]) => `${ip} -> ${Array.from(values).filter(Boolean).join(" / ")}`);
      const adNameSamples = Array.from(names).slice(0, 10);
      const adDnsSamples = Array.from(dnsNames).slice(0, 10);

      return json({
        ok: true,
        synced: computers.length,
        persistedComputers: statements.length,
        directoryComputerRows: directoryComputers.length,
        rawComputerSamples,
        agentAdDiagnostics: Array.from(agentAdDiagnostics.values()).slice(0, 100),
        adNameSamples,
        adDnsSamples,
        matchedInventory: matchedIps.size,
        inventoryHosts: inventory.length,
        eligibleInventoryHosts,
        reservedInventoryHosts,
        inventoryHostsWithHostname: hostsWithHostname,
        hostnameMatches,
        dnsMatches,
        ipMatches,
        inventoryIpUnmatched,
        subnetDiagnostics,
        deviceTypeDiagnostics,
        windowsUnmatchedDiagnostics: Array.from(windowsUnmatchedDiagnostics.entries())
          .map(([reason, total]) => ({ reason, total }))
          .sort((a, b) => b.total - a.total),
        windowsUnmatchedSamples,
                inventoryClassificationDiagnostics: Array.from(inventoryClassificationDiagnostics.entries())
          .map(([classification, stats]) => ({ classification, ...stats }))
          .sort((a, b) => b.total - a.total),
                inventoryAdOsDiagnostics: Array.from(inventoryAdOsDiagnostics.entries())
          .map(([operatingSystem, stats]) => ({ operatingSystem, ...stats }))
          .sort((a, b) => b.total - a.total),
        adDnsServer,
        adDnsServerResolved,
        adDnsWithName,
        adDnsSystemResolved,
        adDnsDirectResolved,
        adDnsUnresolved,
        adDnsResolutionSamples,
        matchMethodCounts,
        matchSamples,
        ipMatchConflicts,
        adDnsIpConflicts: adDnsIpConflicts.size,
        adDnsIpConflictSamples,
        adComputerMultiIpCount,
        adComputerMultiIpDiagnostics,
        inventoryDnsIpConflicts,
        inventoryDnsDiagnostics,
        identityConflicts,
        identityConflictSamples,
        unmatchedSamples,
        unmatchedDiagnostics,
        unmatchedReasonCounts,
        unmatchedReasonSamples,
        matchedSamples
      });
    }

    if (body?.action === "sync-users") {
      const users = await syncAdUsers();
      await initDb();

      const syncTime = new Date().toISOString();
      const statements = users
        .map((user: any) => {
          const username = String(user?.username || "").trim();
          if (!username) return null;
          const personnelId = String(user?.personnelId || user?.employeeNumber || username).trim();
          return {
            sql: "INSERT INTO directory_users(personnel_id,username,user_principal_name,display_name,first_name,last_name,department,title,email,distinguished_name,last_sync) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(personnel_id) DO UPDATE SET username=excluded.username,user_principal_name=excluded.user_principal_name,display_name=excluded.display_name,first_name=excluded.first_name,last_name=excluded.last_name,department=excluded.department,title=excluded.title,email=excluded.email,distinguished_name=excluded.distinguished_name,last_sync=excluded.last_sync",
            params: [personnelId, username, String(user?.userPrincipalName || ""), String(user?.displayName || ""), String(user?.firstName || ""), String(user?.lastName || ""), String(user?.department || ""), String(user?.title || ""), String(user?.email || ""), String(user?.distinguishedName || ""), syncTime]
          };
        })
        .filter(Boolean) as Array<{ sql: string; params: any[] }>;

      if (statements.length) await transaction(statements);

      return json({ ok: true, synced: statements.length, total: users.length });
    }

    if (body?.action === "sync-user" && body?.personnelId) {
      const personnelId = String(body.personnelId).trim();
      const user = await lookupAdUserByPersonnel(personnelId);

      if (!user) {
        return json({ ok: true, found: false, personnelId });
      }

      await initDb();
      await run(
        "INSERT INTO directory_users(personnel_id,username,user_principal_name,display_name,first_name,last_name,department,title,email,distinguished_name,last_sync) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(personnel_id) DO UPDATE SET username=excluded.username,user_principal_name=excluded.user_principal_name,display_name=excluded.display_name,first_name=excluded.first_name,last_name=excluded.last_name,department=excluded.department,title=excluded.title,email=excluded.email,distinguished_name=excluded.distinguished_name,last_sync=excluded.last_sync",
        [
          user.personnelId,
          user.username,
          user.userPrincipalName,
          user.displayName,
          user.firstName,
          user.lastName,
          user.department,
          user.title,
          user.email,
          user.distinguishedName,
          new Date().toISOString()
        ]
      );

      return json({ ok: true, found: true, user });
    }

    if (body?.action === "sync-computer" && body?.computerName) {
      const computer = await lookupAdComputer(String(body.computerName));
      return json({ ok: true, found: Boolean(computer), computer });
    }

    return json({ ok: false, error: "unsupported directory action" }, 400);
  } catch (error) {
    console.error("Active Directory sync failed", error);
    return json({
      ok: false,
      error: error instanceof Error ? error.message : "Active Directory sync failed"
    }, 500);
  }
}
