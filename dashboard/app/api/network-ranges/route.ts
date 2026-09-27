import { NextResponse } from "next/server";
import { all, initDb, run } from "../../../lib/db";
import {
  configuredNetworkRanges,
  inputNetworkRanges,
  persistedConfiguredNetworkRanges,
  saveConfiguredNetworkRanges
} from "../../../lib/network-ranges";
import { detectServerIpv4Ranges } from "../../../lib/server-network";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

function noStoreJson(value: unknown, status = 200) {
  return NextResponse.json(value, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}

export async function GET(request: Request) {
  await initDb();

  const url = new URL(request.url);
  if (url.searchParams.get("config") === "1") {
    const envConfigured = configuredNetworkRanges().map((range) => range.subnet);
    const persistedConfigured = (await persistedConfiguredNetworkRanges()).map((range) => range.subnet);
    return noStoreJson({
      ranges: Array.from(new Set([...envConfigured, ...persistedConfigured]))
    });
  }

  const serverRanges = await detectServerIpv4Ranges();
  const serverNow = new Date().toISOString();

  for (const subnet of serverRanges) {
    await run(
      "INSERT INTO network_ranges(agent_id,subnet,source,first_seen,last_seen) VALUES(?,?,?,?,?) ON CONFLICT(agent_id,subnet) DO UPDATE SET last_seen=excluded.last_seen,source='server-route'",
      ["__server__", subnet, "server-route", serverNow, serverNow]
    );
  }

  const rows = await all<any>(`
    SELECT
      nr.subnet,
      CASE
        WHEN MAX(CASE WHEN nr.source = 'configured' THEN 3 WHEN nr.source = 'server-route' THEN 2 ELSE 1 END) = 3
          THEN 'configured'
        WHEN MAX(CASE WHEN nr.source = 'configured' THEN 3 WHEN nr.source = 'server-route' THEN 2 ELSE 1 END) = 2
          THEN 'server-route'
        ELSE 'observed'
      END AS source,
      MIN(nr.first_seen) AS first_seen,
      MAX(nr.last_seen) AS last_seen,
      (
        SELECT COUNT(DISTINCT nh.ip)
        FROM network_hosts nh
        WHERE nh.subnet = nr.subnet
      ) AS host_count,
      (
        SELECT COUNT(DISTINCT nh.ip)
        FROM network_hosts nh
        WHERE nh.subnet = nr.subnet
          AND nh.reachable = 1
          AND (julianday('now') - julianday(nh.last_seen)) * 86400 <= 600
      ) AS online_hosts
    FROM network_ranges nr
    WHERE nr.agent_id <> '__server_config__'
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

  for (const subnet of serverRanges) {
    if (!bySubnet.has(subnet)) {
      bySubnet.set(subnet, {
        subnet,
        source: "server-route",
        first_seen: null,
        last_seen: null,
        host_count: 0,
        online_hosts: 0
      });
    }
  }

  const envConfigured = configuredNetworkRanges().map((range) => range.subnet);
  const persistedConfigured = (await persistedConfiguredNetworkRanges()).map((range) => range.subnet);
  for (const subnet of Array.from(new Set([...envConfigured, ...persistedConfigured]))) {
    if (!bySubnet.has(subnet)) {
      bySubnet.set(subnet, {
        subnet,
        source: "configured",
        first_seen: null,
        last_seen: null,
        host_count: 0,
        online_hosts: 0
      });
    } else {
      bySubnet.get(subnet).source = "configured";
    }
  }

  return noStoreJson(Array.from(bySubnet.values()).sort((a, b) =>
    a.subnet.localeCompare(b.subnet, undefined, { numeric: true })
  ));
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const rawValue = body?.ranges;
    const ranges = inputNetworkRanges(rawValue);

    const rawItems = Array.isArray(rawValue)
      ? rawValue
      : typeof rawValue === "string"
        ? rawValue.split(/[\s,;]+/).filter(Boolean)
        : [];

    const invalid = rawItems.filter((item: unknown) => !inputNetworkRanges([item]).length);
    if (invalid.length) {
      return noStoreJson(
        { ok: false, error: "رنج نامعتبر است", invalid },
        400
      );
    }

    if (ranges.length > 128) {
      return noStoreJson(
        { ok: false, error: "تعداد رنج‌ها نباید بیشتر از 128 باشد." },
        400
      );
    }

    const saved = await saveConfiguredNetworkRanges(ranges);
    return noStoreJson({ ok: true, ranges: saved });
  } catch (error) {
    console.error("saving network range settings failed", error);
    return noStoreJson({ ok: false, error: "ذخیره تنظیمات رنج‌ها ناموفق بود." }, 500);
  }
}
