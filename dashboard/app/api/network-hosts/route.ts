import { NextResponse } from "next/server";
import { all, initDb } from "../../../lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  await initDb();
  const rows = await all<any>(`
    SELECT
      nh.*,
      c.hostname AS agent_hostname,
      c.ip AS agent_ip
    FROM network_hosts nh
    LEFT JOIN clients c ON c.agent_id = nh.agent_id
    ORDER BY nh.last_seen DESC, nh.subnet ASC, nh.ip ASC
  `);
  const now = Date.now();
  const payload = rows.map((h) => {
    const timestamp = new Date(h.last_seen || h.scanned_at).getTime();
    const age = Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : Number.POSITIVE_INFINITY;
    return {
      ...h,
      status: h.reachable && age <= 10 * 60 * 1000 ? "online" : age <= 30 * 60 * 1000 ? "recent" : "offline"
    };
  });
  return new NextResponse(JSON.stringify(payload), { headers: { "Cache-Control": "no-store" } });
}
