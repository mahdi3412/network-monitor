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
        all<any>("SELECT nh.ip, nh.hostname, c.hostname AS agent_hostname FROM network_hosts nh LEFT JOIN clients c ON c.agent_id = nh.agent_id"),
        all<any>("SELECT name,dns_host_name FROM directory_computers")
      ]);

      const names = new Set<string>();
      const dnsNames = new Set<string>();
      const computersByIp = new Map<string, any>();
      await Promise.all(directoryComputers.map(async (computer: any) => {
        const dnsHostName = normalizeHostname(computer.dns_host_name);
        if (!dnsHostName) return;
        try {
          const addresses = await dns.resolve4(dnsHostName);
          for (const address of addresses) computersByIp.set(address, computer);
        } catch {
          // Ignore stale/unresolvable DNS records; hostname diagnostics still apply.
        }
      }));
      for (const computer of directoryComputers) {
        const name = normalizeHostname(computer.name);
        const dns = normalizeHostname(computer.dns_host_name);
        if (name) names.add(name);
        if (dns) dnsNames.add(dns);
      }

      const matchedIps = new Set<string>();
      let hostsWithHostname = 0;
      let hostnameMatches = 0;
      let dnsMatches = 0;
      let ipMatches = 0;
      const unmatchedSamples: string[] = [];
      const matchedSamples: string[] = [];
      const adNameSamples = Array.from(names).slice(0, 10);
      const adDnsSamples = Array.from(dnsNames).slice(0, 10);

      for (const host of inventory) {
        const candidates = [host.hostname]
          .map(normalizeHostname)
          .filter(Boolean);
        if (!candidates.length) continue;
        hostsWithHostname += 1;

        let hostnameMatch = false;
        let dnsMatch = false;
        let ipMatch = computersByIp.has(host.ip);
        let matchedCandidate = ipMatch ? `${host.ip} -> ${computersByIp.get(host.ip)?.name || ""}` : "";
        for (const candidate of candidates) {
          if (ipMatch) break;
          if (names.has(shortHostname(candidate))) {
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
          if (ipMatch) ipMatches += 1;
          else if (hostnameMatch) hostnameMatches += 1;
          else dnsMatches += 1;
          if (matchedSamples.length < 5) matchedSamples.push(matchedCandidate);
        } else if (unmatchedSamples.length < 10) {
          const sample = candidates.join(" / ");
          if (!unmatchedSamples.includes(sample)) unmatchedSamples.push(sample);
        }
      }

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
        inventoryHostsWithHostname: hostsWithHostname,
        hostnameMatches,
        dnsMatches,
        ipMatches,
        unmatchedSamples,
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
