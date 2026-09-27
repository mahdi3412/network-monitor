import { NextResponse } from "next/server";
import { scanServerNetworks, serverScanStatus } from "../../../lib/server-discovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  return NextResponse.json(serverScanStatus(), {
    headers: { "Cache-Control": "no-store" }
  });
}

export async function POST() {
  try {
    const result = await scanServerNetworks();
    return NextResponse.json({ ok: true, ...result, ...serverScanStatus() }, {
      headers: { "Cache-Control": "no-store" }
    });
  } catch (error) {
    console.error("manual server scan failed", error);
    return NextResponse.json({ ok: false, error: "server scan failed" }, { status: 500 });
  }
}
