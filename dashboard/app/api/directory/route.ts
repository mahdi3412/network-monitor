import { NextResponse } from "next/server";
import { all, initDb, run, transaction } from "../../../lib/db";
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
          const name = String(computer?.name || computer?.dnsHostName || "").trim();
          if (!name) return null;
          return {
            sql: "INSERT INTO directory_computers(name,dns_host_name,operating_system,operating_system_version,description,managed_by,distinguished_name,last_sync) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET dns_host_name=excluded.dns_host_name,operating_system=excluded.operating_system,operating_system_version=excluded.operating_system_version,description=excluded.description,managed_by=excluded.managed_by,distinguished_name=excluded.distinguished_name,last_sync=excluded.last_sync",
            params: [name, String(computer?.dnsHostName || ""), String(computer?.operatingSystem || ""), String(computer?.operatingSystemVersion || ""), String(computer?.description || ""), String(computer?.managedBy || ""), String(computer?.distinguishedName || ""), syncTime]
          };
        })
        .filter(Boolean) as Array<{ sql: string; params: any[] }>;

      if (statements.length) await transaction(statements);

      const matchedInventory = await all<any>(
        "WITH inventory AS (SELECT nh.ip, trim(lower(COALESCE(NULLIF(nh.hostname,''), c.hostname)), '.') AS effective_hostname FROM network_hosts nh LEFT JOIN clients c ON c.agent_id = nh.agent_id) SELECT COUNT(DISTINCT inventory.ip) AS count FROM inventory INNER JOIN directory_computers dc ON trim(lower(dc.name), '.') = trim(lower(CASE WHEN instr(inventory.effective_hostname, '.') > 0 THEN substr(inventory.effective_hostname, 1, instr(inventory.effective_hostname, '.') - 1) ELSE inventory.effective_hostname END), '.') OR trim(lower(dc.dns_host_name), '.') = inventory.effective_hostname"
      );

      return json({
        ok: true,
        synced: computers.length,
        matchedInventory: Number(matchedInventory[0]?.count || 0)
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
