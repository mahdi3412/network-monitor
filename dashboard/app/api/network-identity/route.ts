import { NextResponse } from "next/server";
import { all, initDb } from "../../../lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const methods = ["reverseDns", "pingA", "netbios", "wmi", "cim", "smb", "queryUser", "arp"] as const;

export async function GET() {
  await initDb();

  const rows = await all<any>(`
    SELECT ip,hostname,username,mac,services,device_type,identity_diagnostics,last_seen
    FROM network_hosts
    WHERE agent_id='__server__'
    ORDER BY last_seen DESC, ip ASC
  `);

  const summary: Record<string, Record<string, number>> = {};
  for (const method of methods) summary[method] = { success: 0, none: 0, skipped: 0 };

  const unmatched: Array<{
    ip: string;
    hostname: string;
    username: string;
    deviceType: string;
    services: string[];
    diagnostics: Record<string, string>;
  }> = [];

  let hostsWithUsername = 0;
  const usernameSamples: Array<{ ip: string; username: string; hostname: string; diagnostics: Record<string, string> }> = [];

  for (const row of rows) {
    let diagnostics: Record<string, string> = {};
    try {
      diagnostics = JSON.parse(String(row.identity_diagnostics || "{}"));
    } catch {}

    for (const method of methods) {
      const value = diagnostics[method];
      if (value === "success" || value === "none" || value === "skipped") {
        summary[method][value] += 1;
      }
    }

    if (String(row.username || "").trim()) {
      hostsWithUsername += 1;
      if (usernameSamples.length < 50) {
        usernameSamples.push({
          ip: String(row.ip || ""),
          username: String(row.username || ""),
          hostname: String(row.hostname || ""),
          diagnostics
        });
      }
    }

    if (!String(row.hostname || "").trim()) {
      let services: string[] = [];
      try {
        services = JSON.parse(String(row.services || "[]"));
      } catch {}

      unmatched.push({
        ip: String(row.ip || ""),
        hostname: "",
        username: String(row.username || ""),
        deviceType: String(row.device_type || "unknown"),
        services,
        diagnostics
      });
    }
  }

  return NextResponse.json({
    totalHosts: rows.length,
    unmatchedHostname: unmatched.length,
    hostsWithUsername,
    summary,
    usernameSamples,
    samples: unmatched.slice(0, 50)
  }, {
    headers: { "Cache-Control": "no-store" }
  });
}
