import { NextResponse } from "next/server";
import { all, initDb } from "../../../lib/db";
import { configuredNetworkRanges } from "../../../lib/network-ranges";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  await initDb();

  const rows = await all<any>(`
    SELECT
      nr.subnet,
      CASE
        WHEN SUM(CASE WHEN nr.source = 'configured' THEN 1 ELSE 0 END) > 0
          THEN 'configured'
        ELSE 'observed'
      END AS source,
      MIN(nr.first_seen) AS first_seen,
      MAX(nr.last_seen) AS last_seen,
      COUNT(DISTINCT nh.ip) AS host_count,
      SUM(
        CASE
          WHEN nh.ip IS NOT NULL
            AND nh.reachable = 1
            AND (julianday('now') - julianday(nh.last_seen)) * 86400 <= 600
          THEN 1 ELSE 0
        END
      ) AS online_hosts
    FROM network_ranges nr
    LEFT JOIN network_hosts nh
      ON nh.agent_id = nr.agent_id
      AND nh.subnet = nr.subnet
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

  return NextResponse.json(Array.from(bySubnet.values()).sort((a, b) =>
    a.subnet.localeCompare(b.subnet, undefined, { numeric: true })
  ));
}
