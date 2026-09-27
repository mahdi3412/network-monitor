import { NextResponse } from "next/server";
import { all, initDb, run } from "../../../lib/db";
import { configuredNetworkRanges } from "../../../lib/network-ranges";
import { detectServerIpv4Ranges } from "../../../lib/server-network";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  await initDb();

  const serverRanges = await detectServerIpv4Ranges();
  const serverNow = new Date().toISOString();

  for (const subnet of serverRanges) {
    await run("INSERT INTO network_ranges(agent_id,subnet,source,first_seen,last_seen) VALUES(?,?,?,?,?) ON CONFLICT(agent_id,subnet) DO UPDATE SET last_seen=excluded.last_seen,source='server-route'", ["__server__", subnet, "server-route", serverNow, serverNow]);
  }

  const rows = await all<any>(`
    SELECT
      nr.subnet,
      CASE
        WHEN MAX(CASE WHEN nr.source = 'configured' THEN 3 WHEN nr.source = 'server-route' THEN 2 ELSE 1 END) = 3
          THEN 'configured'
        WHEN MAX(CASE WHEN nr.source = 'configured' THEN 3 WHEN nr.source = 'server-route' THEN 2 ELSE 1 END) = 2
          THEN 'server-route'
        ELSE 'observed'
      END AS source,
      MIN(nr.first_seen) AS first_seen,
      MAX(nr.last_seen) AS last_seen,
      (
        SELECT COUNT(DISTINCT nh.ip)
        FROM network_hosts nh
        WHERE nh.subnet = nr.subnet
      ) AS host_count,
      (
        SELECT COUNT(DISTINCT nh.ip)
        FROM network_hosts nh
        WHERE nh.subnet = nr.subnet
          AND nh.reachable = 1
          AND (julianday('now') - julianday(nh.last_seen)) * 86400 <= 600
      ) AS online_hosts
    FROM network_ranges nr
    GROUP BY nr.subnet
    ORDER BY nr.subnet ASC
  `);

  const bySubnet = new Map<string, any>(
    rows.map((row) => [row.subnet, {
      subnet: row.subnet,
      source: row.source,
      first_seen: row.first_seen,
      last_seen: row.last_seen,
      host_count: Number(row.host_count || 0),
      online_hosts: Number(row.online_hosts || 0)
    }])
  );

  for (const subnet of serverRanges) {
    if (!bySubnet.has(subnet)) {
      bySubnet.set(subnet, { subnet, source: "server-route", first_seen: null, last_seen: null, host_count: 0, online_hosts: 0 });
    }
  }

  for (const range of configuredNetworkRanges()) {
    if (!bySubnet.has(range.subnet)) {
      bySubnet.set(range.subnet, {
        subnet: range.subnet,
        source: "configured",
        first_seen: null,
        last_seen: null,
        host_count: 0,
        online_hosts: 0
      });
    } else {
      bySubnet.get(range.subnet).source = "configured";
    }
  }

  return new NextResponse(JSON.stringify(Array.from(bySubnet.values()).sort((a, b) =>
    a.subnet.localeCompare(b.subnet, undefined, { numeric: true })
  )), { headers: { "Cache-Control": "no-store" } });
}
