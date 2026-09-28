import { NextResponse } from "next/server";
import { all, initDb } from "../../../lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  await initDb();

  const rows = await all<any>(`
    WITH inventory AS (
      SELECT nh.*, c.hostname AS agent_hostname, c.ip AS agent_ip,
        trim(lower(COALESCE(NULLIF(nh.hostname,''), c.hostname)), '.') AS effective_hostname
      FROM network_hosts nh LEFT JOIN clients c ON c.agent_id = nh.agent_id
    )
    SELECT nh.*, nh.agent_hostname, nh.agent_ip,
      du.personnel_id AS directory_personnel_id, du.display_name AS directory_display_name,
      du.first_name AS directory_first_name, du.last_name AS directory_last_name,
      du.department AS directory_department, du.title AS directory_title, du.email AS directory_email,
      du.user_principal_name AS directory_upn,
      dc.name AS ad_computer_name, dc.dns_host_name AS ad_dns_host_name,
      dc.operating_system AS ad_operating_system, dc.operating_system_version AS ad_operating_system_version,
      dc.description AS ad_computer_description, dc.managed_by AS ad_managed_by,
      dc.distinguished_name AS ad_computer_dn,
      CASE WHEN dc.name IS NULL THEN 0 ELSE 1 END AS ad_matched,
      CASE WHEN dc.name IS NULL THEN NULL
        WHEN trim(lower(dc.name), '.') = trim(lower(CASE WHEN instr(nh.effective_hostname, '.') > 0 THEN substr(nh.effective_hostname, 1, instr(nh.effective_hostname, '.') - 1) ELSE nh.effective_hostname END), '.') THEN 'hostname'
        ELSE 'dns' END AS ad_match_type
    FROM inventory nh
    LEFT JOIN directory_users du ON lower(trim(du.username)) = lower(trim(nh.username))
    LEFT JOIN directory_computers dc
      ON trim(lower(dc.name), '.') = trim(lower(CASE WHEN instr(nh.effective_hostname, '.') > 0 THEN substr(nh.effective_hostname, 1, instr(nh.effective_hostname, '.') - 1) ELSE nh.effective_hostname END), '.')
      OR trim(lower(dc.dns_host_name), '.') = nh.effective_hostname
    ORDER BY nh.last_seen DESC, nh.subnet ASC, nh.ip ASC
  `);
  const now = Date.now();
  const merged = new Map<string, any>();

  for (const row of rows) {
    const current = merged.get(row.ip);
    const rowTime = new Date(row.last_seen || row.scanned_at).getTime();
    const currentTime = current
      ? new Date(current.last_seen || current.scanned_at).getTime()
      : -1;

    if (!current || rowTime >= currentTime) {
      merged.set(row.ip, { ...row });
      continue;
    }

    if (!current.hostname && row.hostname) current.hostname = row.hostname;
    if (!current.username && row.username) current.username = row.username;
    if (!current.directory_personnel_id && row.directory_personnel_id) current.directory_personnel_id = row.directory_personnel_id;
    if (!current.directory_display_name && row.directory_display_name) current.directory_display_name = row.directory_display_name;
    if (!current.directory_first_name && row.directory_first_name) current.directory_first_name = row.directory_first_name;
    if (!current.directory_last_name && row.directory_last_name) current.directory_last_name = row.directory_last_name;
    if (!current.directory_department && row.directory_department) current.directory_department = row.directory_department;
    if (!current.directory_title && row.directory_title) current.directory_title = row.directory_title;
    if (!current.directory_email && row.directory_email) current.directory_email = row.directory_email;
    if (!current.directory_upn && row.directory_upn) current.directory_upn = row.directory_upn;
    if (!current.ad_computer_name && row.ad_computer_name) current.ad_computer_name = row.ad_computer_name;
    if (!current.ad_dns_host_name && row.ad_dns_host_name) current.ad_dns_host_name = row.ad_dns_host_name;
    if (!current.ad_operating_system && row.ad_operating_system) current.ad_operating_system = row.ad_operating_system;
    if (!current.ad_operating_system_version && row.ad_operating_system_version) current.ad_operating_system_version = row.ad_operating_system_version;
    if (!current.ad_computer_description && row.ad_computer_description) current.ad_computer_description = row.ad_computer_description;
    if (!current.ad_managed_by && row.ad_managed_by) current.ad_managed_by = row.ad_managed_by;
    if (!current.ad_computer_dn && row.ad_computer_dn) current.ad_computer_dn = row.ad_computer_dn;
    if (!current.ad_matched && row.ad_matched) current.ad_matched = row.ad_matched;
    if (!current.ad_match_type && row.ad_match_type) current.ad_match_type = row.ad_match_type;
    if (!current.mac && row.mac) current.mac = row.mac;
    if (!current.subnet && row.subnet) current.subnet = row.subnet;
    if (!current.device_type && row.device_type) current.device_type = row.device_type;
    if ((!current.services || current.services === "[]") && row.services) current.services = row.services;
  }

  const payload = Array.from(merged.values()).map((h) => {
    const timestamp = new Date(h.last_seen || h.scanned_at).getTime();
    const age = Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : Number.POSITIVE_INFINITY;

    return {
      ...h,
      status: h.reachable && age <= 10 * 60 * 1000
        ? "online"
        : age <= 30 * 60 * 1000
          ? "recent"
          : "offline"
    };
  });

  return new NextResponse(JSON.stringify(payload), {
    headers: { "Cache-Control": "no-store" }
  });
}
