import { NextResponse } from "next/server";
import { all, initDb } from "../../../lib/db";
import { configuredNetworkRanges } from "../../../lib/network-ranges";
import { detectServerIpv4Ranges } from "../../../lib/server-network";
import { serverScanStatus } from "../../../lib/server-discovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  await initDb();

  const [clients, hosts, ranges, lastHeartbeat, lastScan] = await Promise.all([
    all<any>("SELECT COUNT(*) AS count FROM clients"),
    all<any>("SELECT COUNT(DISTINCT ip) AS count FROM network_hosts"),
    all<any>("SELECT COUNT(DISTINCT subnet) AS count FROM network_ranges"),
    all<any>("SELECT received_at FROM heartbeats ORDER BY received_at DESC LIMIT 1"),
    all<any>("SELECT * FROM network_scan_runs ORDER BY id DESC LIMIT 1")
  ]);

  const detectedRanges = await detectServerIpv4Ranges();
  const configuredRanges = configuredNetworkRanges().map((range) => range.subnet);

  return new NextResponse(JSON.stringify({
    ok: true,
    time: new Date().toISOString(),
    database: {
      clients: Number(clients[0]?.count || 0),
      hosts: Number(hosts[0]?.count || 0),
      ranges: Number(ranges[0]?.count || 0)
    },
    heartbeat: {
      lastReceivedAt: lastHeartbeat[0]?.received_at || null
    },
    discovery: {
      scanning: serverScanStatus().scanning,
      lastRun: lastScan[0] || null,
      serverDetectedRanges: detectedRanges,
      configuredRanges,
      configuredRangeCount: configuredRanges.length
    }
  }), {
    headers: { "Cache-Control": "no-store" }
  });
}
