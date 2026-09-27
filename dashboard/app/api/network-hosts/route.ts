import { NextResponse } from "next/server";
import { all, initDb } from "../../../lib/db";

export const runtime = "nodejs";

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
  return NextResponse.json(rows.map((h) => {
    const age = now - new Date(h.last_seen || h.scanned_at).getTime();
    return {
      ...h,
      status: age <= 10 * 60 * 1000 ? "online" : age <= 30 * 60 * 1000 ? "recent" : "offline"
    };
  }));
}
