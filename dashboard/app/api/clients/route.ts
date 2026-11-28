import { NextResponse } from "next/server";
import { all, initDb } from "../../../lib/db";
import { CLIENT_COLUMNS } from "../../../lib/client-columns";
import { clientStatusFromLastSeen } from "../../../lib/heartbeat-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  await initDb();
  const clients = await all<any>(`SELECT ${CLIENT_COLUMNS} FROM clients ORDER BY last_seen DESC`);
  const now = Date.now();

  const payload = clients.map((client) => ({
    ...client,
    status: clientStatusFromLastSeen(client.last_seen, now)
  }));

  return new NextResponse(JSON.stringify(payload), {
    headers: { "Cache-Control": "no-store" }
  });
}
