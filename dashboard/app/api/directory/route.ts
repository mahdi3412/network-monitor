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
        all<any>("SELECT nh.ip, nh.hostname, nh.subnet, nh.device_type, nh.last_seen, c.hostname AS agent_hostname FROM network_hosts nh LEFT JOIN clients c ON c.agent_id = nh.agent_id"),
        all<any>("SELECT name,dns_host_name FROM directory_computers")
      ]);

      const names = new Set<string>();
      const dnsNames = new Set<string>();
      const dnsShortNames = new Set<string>();
      const computerByDnsShort = new Map<string, any>();
      const computersByIp = new Map<string, any>();
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
            for (const address of addresses) computersByIp.set(address, computer);
            if (adDnsResolutionSamples.length < 10) {
              adDnsResolutionSamples.push(`${dnsHostName} -> ${addresses.join(",")}`);
            }
            return;
          }
        } catch {}

        adDnsUnresolved += 1;
        if (adDnsResolutionSamples.length < 10) adDnsResolutionSamples.push(dnsHostName);
      }));

      const matchedIps = new Set<string>();
      let reservedInventoryHosts = 0;
      let eligibleInventoryHosts = 0;
      let hostsWithHostname = 0;
      let hostnameMatches = 0;
      let dnsMatches = 0;
      let ipMatches = 0;
      let ipMatchConflicts = 0;
      const matchMethodCounts = { ip: 0, hostname: 0, dns: 0 };
      const matchSamples = { ip: [] as string[], hostname: [] as string[], dns: [] as string[] };
      const unmatchedSamples: string[] = [];
      const unmatchedDiagnostics: string[] = [];
      const unmatchedByDeviceType: string[] = [];
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

        const candidates = [
          host.hostname,
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
        let matchedCandidate = ipMatch ? `${host.ip} -> ${ipComputer?.name || ipComputer?.dns_host_name || ""}` : "";

        for (const candidate of candidates) {
          if (ipMatch) break;
          const shortCandidate = shortHostname(candidate);
          if (names.has(shortCandidate) || dnsShortNames.has(shortCandidate)) {
            hostnameMatch = true;
            matchedCandidate = candidate;
            break;
          }
          if (dnsNames.has(candidate)) {
            dnsMatch = true;
            matchedCandidate = candidate;
            break;
          }
        }

        if (hostnameMatch || dnsMatch || ipMatch) {
          matchedIps.add(host.ip);
          if (ipMatch) {
            ipMatches += 1;
            subnetStats.ipMatches += 1;
            deviceStats.ipMatches += 1;
            matchMethodCounts.ip += 1;
            if (hostnameMatch || dnsMatch) ipMatchConflicts += 1;
            if (matchSamples.ip.length < 10) matchSamples.ip.push(matchedCandidate);
          } else if (hostnameMatch) {
            hostnameMatches += 1;
            matchMethodCounts.hostname += 1;
            if (matchSamples.hostname.length < 10) matchSamples.hostname.push(`${matchedCandidate} -> ${host.ip}`);
          } else {
            dnsMatches += 1;
            matchMethodCounts.dns += 1;
            if (matchSamples.dns.length < 10) matchSamples.dns.push(`${matchedCandidate} -> ${host.ip}`);
          }
          if (matchedSamples.length < 5) matchedSamples.push(matchedCandidate);
        } else {
          inventoryIpUnmatched += 1;
          if (unmatchedSamples.length < 10) {
            const sample = `${host.ip} | ${candidates.join(" / ") || "بدون hostname"}`;
            if (!unmatchedSamples.includes(sample)) unmatchedSamples.push(sample);
          }
          if (unmatchedDiagnostics.length < 20) {
            const reverseNames = inventoryReverseNames.get(normalizedIp) || [];
            const shortCandidates = candidates.map(shortHostname).filter(Boolean);
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
      }

      const subnetDiagnostics = Array.from(inventoryBySubnet.entries())
        .map(([subnet, stats]) => ({ subnet, ...stats }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 15);
      const deviceTypeDiagnostics = Array.from(inventoryByDeviceType.entries())
        .map(([deviceType, stats]) => ({ deviceType, ...stats }))
        .sort((a, b) => b.total - a.total);

      const adNameSamples = Array.from(names).slice(0, 10);
      const adDnsSamples = Array.from(dnsNames).slice(0, 10);

      return json({
        ok: true,
        synced: computers.length,
        persistedComputers: statements.length,
        directoryComputerRows: directoryComputers.length,
        rawComputerSamples,
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
        unmatchedSamples,
        unmatchedDiagnostics,
        unmatchedByDeviceType,
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
