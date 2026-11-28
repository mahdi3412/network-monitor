import { NextResponse } from "next/server";
import { all, initDb } from "../../../lib/db";
import { clientStatusFromLastSeen } from "../../../lib/heartbeat-config";
import { buildInventoryQuery, duplicateCountQuery, summaryQuery } from "../../../lib/inventory-query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const CSV_HEADERS = [
  "نام کامپیوتر", "IP", "MAC", "نام کاربری", "نام", "نام خانوادگی",
  "شماره پرسنلی", "ویندوز", "وضعیت", "آخرین زمان دیده‌شدن", "تکراری",
  "سازنده", "مدل", "سریال", "آخرین بوت", "دیسک کل (GB)", "دیسک آزاد (GB)", "دامنه"
];
const STATUS_FA: Record<string, string> = { online: "آنلاین", recent: "اخیراً دیده‌شده", offline: "آفلاین" };

// جلوگیری از اجرای فرمول در Excel (CSV injection) و escape استاندارد CSV
function csvCell(value: unknown) {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  if (/[",\n\r]/.test(text)) text = '"' + text.replace(/"/g, '""') + '"';
  return text;
}

export async function GET(req: Request) {
  try {
    await initDb();
    const now = Date.now();
    const query = buildInventoryQuery(new URL(req.url).searchParams, now);

    const rows = await all<any>(query.listSql, query.listArgs as any[]);
    const items = rows.map((row) => {
      const status = clientStatusFromLastSeen(row.last_seen, now);
      return {
        ...row,
        status,
        dup_ip: !!row.dup_ip,
        dup_mac: !!row.dup_mac,
        dup_host: !!row.dup_host
      };
    });

    if (query.csv) {
      const lines = [CSV_HEADERS.map(csvCell).join(",")];
      for (const r of items) {
        const dups = [r.dup_ip && "IP", r.dup_mac && "MAC", r.dup_host && "Hostname"].filter(Boolean).join(" ");
        lines.push(
          [r.hostname, r.ip, r.mac, r.username, r.first_name, r.last_name, r.personnel_id,
            r.os_version, STATUS_FA[r.status], r.last_seen, dups,
            r.manufacturer, r.model, r.serial_number, r.last_boot, r.disk_total_gb, r.disk_free_gb, r.domain
          ].map(csvCell).join(",")
        );
      }
      const day = new Date(now).toISOString().slice(0, 10);
      return new NextResponse("\uFEFF" + lines.join("\r\n"), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="inventory-${day}.csv"`,
          "Cache-Control": "no-store"
        }
      });
    }

    const [countRows, summaryRows, dupRows] = await Promise.all([
      all<any>(query.countSql, query.countArgs as any[]),
      all<any>(summaryQuery(now).sql, summaryQuery(now).args),
      all<any>(duplicateCountQuery(now).sql, duplicateCountQuery(now).args)
    ]);

    const total = Number(summaryRows[0]?.total || 0);
    const online = Number(summaryRows[0]?.online || 0);
    const recent = Number(summaryRows[0]?.recent || 0);

    return new NextResponse(
      JSON.stringify({
        items,
        total: Number(countRows[0]?.n || 0),
        page: query.page,
        pageSize: query.pageSize,
        summary: {
          total,
          online,
          recent,
          offline: Math.max(0, total - online - recent),
          duplicates: Number(dupRows[0]?.n || 0)
        }
      }),
      { headers: { "Cache-Control": "no-store", "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("inventory failed", error);
    return NextResponse.json({ error: "inventory failed" }, { status: 500 });
  }
}
