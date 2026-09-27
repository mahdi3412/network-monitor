import { NextResponse } from "next/server";
import crypto from "crypto";
import { all, initDb, run } from "../../../lib/db";
import { configuredNetworkRanges, inputNetworkRanges } from "../../../lib/network-ranges";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(req: Request) {
  try {
    await initDb();
    const body = await req.json();

    if (!body.agentId || !body.hostname) {
      return NextResponse.json({ error: "agentId and hostname are required" }, { status: 400 });
    }

    const agentId = String(body.agentId);
    const key = req.headers.get("x-agent-key") || "";
    const now = new Date().toISOString();
    const rawLatency = Number(body.latencyMs);
    const latencyMs = Number.isFinite(rawLatency) ? Math.max(0, Math.round(rawLatency)) : null;

    const existing = await all<any>(
      "SELECT api_key_hash FROM clients WHERE agent_id=?",
      [agentId]
    );

    if (
      existing.length &&
      (!key ||
        crypto.createHash("sha256").update(key).digest("hex") !== existing[0].api_key_hash)
    ) {
      return NextResponse.json({ error: "invalid agent key" }, { status: 401 });
    }

    const apiKey = existing.length ? key : crypto.randomBytes(24).toString("hex");
    const apiKeyHash = crypto.createHash("sha256").update(apiKey).digest("hex");

    await run(
      "INSERT INTO clients (agent_id,ip,mac,hostname,username,first_name,last_name,personnel_id,os,os_version,cpu,ram_mb,gateway,dns,adapter,agent_version,last_seen,created_at,api_key_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET ip=excluded.ip,mac=excluded.mac,hostname=excluded.hostname,username=excluded.username,first_name=excluded.first_name,last_name=excluded.last_name,personnel_id=excluded.personnel_id,os=excluded.os,os_version=excluded.os_version,cpu=excluded.cpu,ram_mb=excluded.ram_mb,gateway=excluded.gateway,dns=excluded.dns,adapter=excluded.adapter,agent_version=excluded.agent_version,last_seen=excluded.last_seen",
      [
        agentId, body.ip, body.mac, body.hostname, body.username, body.firstName, body.lastName,
        body.personnelId, body.os, body.osVersion, body.cpu, body.ramMb, body.gateway, body.dns,
        body.adapter, body.agentVersion, now, now, apiKeyHash
      ]
    );

    await run(
      "INSERT INTO heartbeats(agent_id,ip,hostname,username,received_at,latency_ms) VALUES(?,?,?,?,?,?)",
      [agentId, body.ip, body.hostname, body.username, now, latencyMs]
    );

    const hosts = Array.isArray(body.networkHosts) ? body.networkHosts : [];

    for (const h of hosts.slice(0, 8192)) {
      if (!h || !h.ip) continue;

      const rawHostLatency = Number(h.latencyMs);
      const hostLatencyMs = Number.isFinite(rawHostLatency)
        ? Math.max(0, Math.round(rawHostLatency))
        : null;

      await run(
        "INSERT INTO network_hosts (agent_id,ip,hostname,mac,adapter,subnet,method,device_type,services,latency_ms,reachable,scanned_at,first_seen,last_seen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(agent_id,ip) DO UPDATE SET hostname=CASE WHEN excluded.hostname<>'' THEN excluded.hostname ELSE network_hosts.hostname END,mac=CASE WHEN excluded.mac<>'' THEN excluded.mac ELSE network_hosts.mac END,adapter=CASE WHEN excluded.adapter<>'' THEN excluded.adapter ELSE network_hosts.adapter END,subnet=CASE WHEN excluded.subnet<>'' THEN excluded.subnet ELSE network_hosts.subnet END,method=excluded.method,device_type=CASE WHEN excluded.device_type<>'' AND excluded.device_type<>'unknown' THEN excluded.device_type ELSE network_hosts.device_type END,services=CASE WHEN excluded.services<>'[]' THEN excluded.services ELSE network_hosts.services END,latency_ms=excluded.latency_ms,reachable=excluded.reachable,scanned_at=excluded.scanned_at,last_seen=excluded.last_seen",
        [
          agentId,
          String(h.ip),
          String(h.hostname || ""),
          String(h.mac || ""),
          String(h.adapter || ""),
          String(h.subnet || ""),
          String(h.method || "icmp"),
          String(h.deviceType || "unknown"),
          JSON.stringify(Array.isArray(h.services) ? h.services : []),
          hostLatencyMs,
          h.reachable ? 1 : 0,
          now,
          now,
          now
        ]
      );
    }

    const observedRanges = hosts
      .map((h: any) => h && h.subnet ? String(h.subnet) : "")
      .filter(Boolean);

    const declaredRanges = inputNetworkRanges(body.networkRanges);
    const serverRanges = configuredNetworkRanges().map((range) => range.subnet);
    const allRanges = Array.from(new Set([...observedRanges, ...declaredRanges, ...serverRanges]));

    for (const subnet of allRanges) {
      const source =
        serverRanges.includes(subnet) || declaredRanges.includes(subnet)
          ? "configured"
          : "observed";

      await run(
        "INSERT INTO network_ranges(agent_id,subnet,source,first_seen,last_seen) VALUES(?,?,?,?,?) ON CONFLICT(agent_id,subnet) DO UPDATE SET last_seen=excluded.last_seen,source=CASE WHEN network_ranges.source='configured' THEN 'configured' ELSE excluded.source END",
        [agentId, subnet, source, now, now]
      );
    }

    await run(
      "DELETE FROM heartbeats WHERE received_at < ?",
      [new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()]
    );

    return NextResponse.json({
      ok: true,
      serverTime: now,
      agentKey: existing.length ? undefined : apiKey,
      receivedHosts: hosts.length,
      knownRanges: allRanges.length
    });
  } catch (error) {
    console.error("heartbeat failed", error);
    return NextResponse.json({ error: "heartbeat failed" }, { status: 500 });
  }
}
