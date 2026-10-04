import { NextResponse } from "next/server";
import dns from "node:dns/promises";
import { all, initDb } from "../../../lib/db";
import { normalizeHostname, shortHostname } from "../../../lib/hostname";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  await initDb();

  const [rows, directoryComputers, clients, directoryUsers] = await Promise.all([
    all<any>(`
      SELECT nh.*, c.hostname AS agent_hostname, c.ip AS agent_ip,
        du.personnel_id AS directory_personnel_id, du.display_name AS directory_display_name,
        du.first_name AS directory_first_name, du.last_name AS directory_last_name,
        du.department AS directory_department, du.title AS directory_title, du.email AS directory_email,
        du.user_principal_name AS directory_upn
      FROM network_hosts nh
      LEFT JOIN clients c ON c.agent_id = nh.agent_id
      LEFT JOIN directory_users du ON lower(trim(du.username)) = lower(trim(nh.username))
      ORDER BY nh.last_seen DESC, nh.subnet ASC, nh.ip ASC
    `),
    all<any>("SELECT name,dns_host_name,operating_system,operating_system_version,description,managed_by,distinguished_name FROM directory_computers"),
    all<any>("SELECT agent_id,ip,mac,hostname,username,first_name,last_name,personnel_id,adapter FROM clients"),
    all<any>("SELECT personnel_id,username,user_principal_name,display_name,first_name,last_name,department,title,email FROM directory_users")
  ]);

  const clientByIp = new Map<string, any>();
  const clientByMac = new Map<string, any>();
  const directoryUserByUsername = new Map<string, any>();
  const directoryUserByPersonnel = new Map<string, any>();

  for (const client of clients) {
    const ip = String(client.ip || "").trim();
    const mac = String(client.mac || "").trim().toLowerCase().replace(/[^0-9a-f]/g, "");
    if (ip) clientByIp.set(ip, client);
    if (mac) clientByMac.set(mac, client);
  }

  for (const user of directoryUsers) {
    const username = String(user.username || "").trim().toLowerCase();
    const personnel = String(user.personnel_id || "").trim().toLowerCase();
    if (username) directoryUserByUsername.set(username, user);
    if (personnel) directoryUserByPersonnel.set(personnel, user);
  }

  const adDnsResolver = new dns.Resolver();
  let adDnsServerResolved = false;
  try {
    const adServer = (await dns.resolve4(String(process.env.AD_URLS || "").split(/[;,\s]+/).map((v) => v.replace(/^ldaps?:\/\//i, "").replace(/:\d+$/, "")).find(Boolean) || ""))[0];
    if (adServer) {
      adDnsResolver.setServers([adServer]);
      adDnsServerResolved = true;
    }
  } catch {}

  const computersByName = new Map<string, any>();
  const computersByDns = new Map<string, any>();
  const computersByDnsShort = new Map<string, any>();
  const computersByIp = new Map<string, any>();

  await Promise.all(directoryComputers.map(async (computer) => {
    const dnsHostName = normalizeHostname(computer.dns_host_name);
    if (!dnsHostName) return;
    let addresses: string[] = [];
    try {
      addresses = await dns.resolve4(dnsHostName);
    } catch {}
    if (!addresses.length && adDnsServerResolved) {
      try {
        addresses = await adDnsResolver.resolve4(dnsHostName);
      } catch {}
    }
    for (const address of addresses) computersByIp.set(address, computer);
  }));

  for (const computer of directoryComputers) {
    const name = normalizeHostname(computer.name);
    const dns = normalizeHostname(computer.dns_host_name);
    if (name) computersByName.set(name, computer);
    if (dns) {
      computersByDns.set(dns, computer);
      const dnsShort = shortHostname(dns);
      if (dnsShort) computersByDnsShort.set(dnsShort, computer);
    }
  }

  for (const row of rows) {
    const client = clientByIp.get(String(row.ip || "").trim()) || null;
    const rowMac = String(row.mac || "").trim().toLowerCase().replace(/[^0-9a-f]/g, "");
    const macClient = rowMac ? clientByMac.get(rowMac) : null;
    const identityClient = client || macClient;
    const effectiveUsername = String(row.username || identityClient?.username || "").trim();
    const effectivePersonnel = String(identityClient?.personnel_id || "").trim();
    const directoryUser =
      (effectivePersonnel ? directoryUserByPersonnel.get(effectivePersonnel.toLowerCase()) : null) ||
      (effectiveUsername ? directoryUserByUsername.get(effectiveUsername.toLowerCase()) : null);

    if (!row.username && effectiveUsername) row.username = effectiveUsername;
    if (!row.mac && identityClient?.mac) row.mac = identityClient.mac;
    if (!row.adapter && identityClient?.adapter) row.adapter = identityClient.adapter;
    if (!row.agent_hostname && identityClient?.hostname) row.agent_hostname = identityClient.hostname;
    if (!row.agent_ip && identityClient?.ip) row.agent_ip = identityClient.ip;

    if (directoryUser) {
      row.directory_personnel_id = row.directory_personnel_id || directoryUser.personnel_id || effectivePersonnel || null;
      row.directory_display_name = row.directory_display_name || directoryUser.display_name || [directoryUser.first_name, directoryUser.last_name].filter(Boolean).join(" ") || null;
      row.directory_first_name = row.directory_first_name || directoryUser.first_name || null;
      row.directory_last_name = row.directory_last_name || directoryUser.last_name || null;
      row.directory_department = row.directory_department || directoryUser.department || null;
      row.directory_title = row.directory_title || directoryUser.title || null;
      row.directory_email = row.directory_email || directoryUser.email || null;
      row.directory_upn = row.directory_upn || directoryUser.user_principal_name || null;
    }

    const hostnameCandidates = [row.hostname, identityClient?.hostname]
      .map(normalizeHostname)
      .filter(Boolean);
    let computer: any = computersByIp.get(row.ip) || null;
    let matchType: string | null = computer ? "ip" : null;

    for (const candidate of hostnameCandidates) {
      if (computer) break;
      const shortName = shortHostname(candidate);
      computer = computersByName.get(shortName) || computersByDnsShort.get(shortName) || computersByDns.get(candidate);
      if (computer) {
        matchType = computersByName.has(shortName) ? "hostname" : computersByDnsShort.has(shortName) ? "dns-short" : "dns";
        break;
      }
    }

    row.ad_computer_name = computer?.name || null;
    if (!row.hostname && computer?.dns_host_name) row.hostname = shortHostname(computer.dns_host_name);
    if (!row.hostname && computer?.name) row.hostname = computer.name;
    row.ad_dns_host_name = computer?.dns_host_name || null;
    row.ad_operating_system = computer?.operating_system || null;
    row.ad_operating_system_version = computer?.operating_system_version || null;
    row.ad_computer_description = computer?.description || null;
    row.ad_managed_by = computer?.managed_by || null;
    row.ad_computer_dn = computer?.distinguished_name || null;
    row.ad_matched = computer ? 1 : 0;
    row.ad_match_type = matchType;
  }

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
