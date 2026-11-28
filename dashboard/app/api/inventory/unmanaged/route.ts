import { NextResponse } from "next/server";
import { all, initDb, run } from "../../../../lib/db";
import { buildUnmanagedQuery } from "../../../../lib/unmanaged-query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const CSV_HEADERS = ["IP", "نام", "MAC", "نوع دستگاه", "سرویس‌ها", "کاربر", "زیرشبکه", "اولین بار", "آخرین بار", "وضعیت"];
const TYPE_FA: Record<string, string> = {
  windows: "ویندوز",
  printer: "چاپگر",
  "linux-or-network": "لینوکس / تجهیزات شبکه",
  unknown: "نامشخص"
};

// جلوگیری از اجرای فرمول در Excel (CSV injection) و escape استاندارد CSV
function csvCell(value: unknown) {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  if (/[",\n\r]/.test(text)) text = '"' + text.replace(/"/g, '""') + '"';
  return text;
}

function parseServices(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

// ایندکس‌های لازم برای تطبیق سریع میزبان‌ها با کلاینت‌ها (یک‌بار در هر پروسه)
let indexesReady = false;
async function ensureIndexes() {
  if (indexesReady) return;
  await run("CREATE INDEX IF NOT EXISTS idx_clients_mac_lower ON clients(lower(mac))");
  await run("CREATE INDEX IF NOT EXISTS idx_clients_hostname_lower ON clients(lower(hostname))");
  await run("CREATE INDEX IF NOT EXISTS idx_network_hosts_agent_seen ON network_hosts(agent_id,last_seen)");
  indexesReady = true;
}

export async function GET(req: Request) {
  try {
    await initDb();
    await ensureIndexes();

    const now = Date.now();
    const query = buildUnmanagedQuery(new URL(req.url).searchParams, now);

    // میزبانی «آنلاین» است که در ۲ دوره اسکن اخیر دیده شده باشد
    const scanIntervalMs = Math.max(60, Number(process.env.NETWORK_SCAN_INTERVAL_SECONDS || 900)) * 1000;
    const onlineSince = new Date(now - scanIntervalMs * 2).toISOString();

    const rows = await all<any>(query.listSql, query.listArgs as any[]);
    const items = rows.map((row) => ({
      ...row,
      services: parseServices(row.services),
      online: String(row.last_seen || "") >= onlineSince
    }));

    if (query.csv) {
      const lines = [CSV_HEADERS.map(csvCell).join(",")];
      for (const r of items) {
        lines.push(
          [r.ip, r.hostname, r.mac, TYPE_FA[r.device_type || "unknown"] || r.device_type, r.services.join(" "),
            r.username, r.subnet, r.first_seen, r.last_seen, r.online ? "آنلاین" : "آفلاین"].map(csvCell).join(",")
        );
      }
      const day = new Date(now).toISOString().slice(0, 10);
      return new NextResponse("\uFEFF" + lines.join("\r\n"), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="unmanaged-devices-${day}.csv"`,
          "Cache-Control": "no-store"
        }
      });
    }

    const [countRows, typeRows] = await Promise.all([
      all<any>(query.countSql, query.countArgs as any[]),
      all<any>(query.typesSql, query.typesArgs as any[])
    ]);

    return new NextResponse(
      JSON.stringify({
        items,
        total: Number(countRows[0]?.n || 0),
        page: query.page,
        pageSize: query.pageSize,
        days: query.days,
        types: typeRows.map((row) => ({ type: String(row.type), count: Number(row.n || 0) }))
      }),
      { headers: { "Cache-Control": "no-store", "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("unmanaged inventory failed", error);
    return NextResponse.json({ error: "unmanaged inventory failed" }, { status: 500 });
  }
}
