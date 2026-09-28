import { NextResponse } from "next/server";
import { all, initDb, run } from "../../../lib/db";
import {
  getAdConfig,
  lookupAdComputer,
  lookupAdUserByPersonnel,
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

    if (body?.action === "sync-users") {
      const users = await syncAdUsers();
      await initDb();

      let synced = 0;
      for (const user of users) {
        const username = String(user?.username || "").trim();
        if (!username) continue;

        const personnelId = String(user?.personnelId || user?.employeeNumber || username).trim();
        await run(
          "INSERT INTO directory_users(personnel_id,username,user_principal_name,display_name,first_name,last_name,department,title,email,distinguished_name,last_sync) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(personnel_id) DO UPDATE SET username=excluded.username,user_principal_name=excluded.user_principal_name,display_name=excluded.display_name,first_name=excluded.first_name,last_name=excluded.last_name,department=excluded.department,title=excluded.title,email=excluded.email,distinguished_name=excluded.distinguished_name,last_sync=excluded.last_sync",
          [
            personnelId,
            username,
            String(user?.userPrincipalName || ""),
            String(user?.displayName || ""),
            String(user?.firstName || ""),
            String(user?.lastName || ""),
            String(user?.department || ""),
            String(user?.title || ""),
            String(user?.email || ""),
            String(user?.distinguishedName || ""),
            new Date().toISOString()
          ]
        );
        synced += 1;
      }

      return json({ ok: true, synced, total: users.length });
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
