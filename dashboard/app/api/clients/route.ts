import { NextResponse } from "next/server";
import { all, initDb } from "../../../lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  await initDb();
  const clients = await all<any>("SELECT * FROM clients ORDER BY last_seen DESC");
  const now = Date.now();

  const payload = clients.map((client) => {
    const timestamp = new Date(client.last_seen).getTime();
    const age = Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : Number.POSITIVE_INFINITY;

    return {
      ...client,
      status: age <= 90000 ? "online" : age <= 300000 ? "recent" : "offline"
    };
  });

  return new NextResponse(JSON.stringify(payload), {
    headers: { "Cache-Control": "no-store" }
  });
}
