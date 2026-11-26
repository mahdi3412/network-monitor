import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { all, initDb } from "../../../lib/db";
import { heartbeatIntervalSeconds, statusCutoffs } from "../../../lib/heartbeat-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const isTrue = (value: string | undefined) => ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());

function fileSize(file: string) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

// وضعیت سلامت سرور برای پایش (مثلاً با Uptime Kuma یا اسکریپت): 200 = سالم، 503 = خطای دیتابیس
export async function GET() {
  try {
    await initDb();
    const now = Date.now();
    const cutoffs = statusCutoffs(now);
    const warnings: string[] = [];

    const clients = (
      await all<any>(
        "SELECT COUNT(*) AS total, SUM(CASE WHEN last_seen>=? THEN 1 ELSE 0 END) AS online, MAX(last_seen) AS last_heartbeat FROM clients",
        [cutoffs.online]
      )
    )[0];
    const total = Number(clients?.total || 0);
    const lastHeartbeat: string | null = clients?.last_heartbeat || null;

    if (total > 0 && lastHeartbeat && lastHeartbeat < cutoffs.online) {
      warnings.push("هیچ heartbeat اخیری دریافت نشده است");
    }

    const scan = (
      await all<any>(
        "SELECT started_at,finished_at,status,discovered_hosts,error FROM network_scan_runs ORDER BY id DESC LIMIT 1"
      )
    )[0];
    if (scan?.status === "error") warnings.push("آخرین اسکن شبکه با خطا تمام شد");

    const adEnabled = isTrue(process.env.AD_ENABLED);
    const ad = (await all<any>("SELECT COUNT(*) AS n, MAX(last_sync) AS last_sync FROM directory_users"))[0];
    if (adEnabled) {
      const syncMinutes = Math.max(10, Number(process.env.AD_SYNC_INTERVAL_MINUTES || 60));
      const staleBefore = new Date(now - syncMinutes * 3 * 60 * 1000).toISOString();
      if (!ad?.last_sync) warnings.push("همگام‌سازی کاربران AD هنوز انجام نشده است");
      else if (ad.last_sync < staleBefore) warnings.push("همگام‌سازی کاربران AD قدیمی است");
    }

    const dbFile = path.join(process.cwd(), "data", "network-monitor.db");

    return NextResponse.json(
      {
        status: warnings.length ? "degraded" : "ok",
        warnings,
        time: new Date(now).toISOString(),
        heartbeatIntervalSeconds: heartbeatIntervalSeconds(),
        clients: { total, online: Number(clients?.online || 0), lastHeartbeat },
        lastScan: scan
          ? { startedAt: scan.started_at, finishedAt: scan.finished_at, status: scan.status, discoveredHosts: scan.discovered_hosts }
          : null,
        ad: { enabled: adEnabled, users: Number(ad?.n || 0), lastSync: ad?.last_sync || null },
        databaseBytes: fileSize(dbFile) + fileSize(dbFile + "-wal")
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("health check failed", error);
    return NextResponse.json({ status: "error" }, { status: 503 });
  }
}
