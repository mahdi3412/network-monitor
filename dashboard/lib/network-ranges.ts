import { all, initDb, run } from "./db";

export const SERVER_CONFIG_AGENT_ID = "__server_config__";

export type NetworkRange = {
  subnet: string;
  source: "configured" | "observed";
};

function ipv4ToInt(ip: string) {
  return ip.split(".").reduce((n, octet) => (n << 8) + Number(octet), 0) >>> 0;
}

function intToIpv4(value: number) {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

export function normalizeCidr(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  const parts = raw.split("/");
  if (parts.length !== 2 || !/^\d+$/.test(parts[1])) return null;

  const octets = parts[0].split(".");
  if (octets.length !== 4 || octets.some((x) => !/^\d+$/.test(x) || Number(x) > 255)) return null;

  const prefix = Number(parts[1]);
  if (prefix < 1 || prefix > 32) return null;

  const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ipv4ToInt(parts[0]) & mask) >>> 0;
  return intToIpv4(network) + "/" + prefix;
}

export function configuredNetworkRanges(): NetworkRange[] {
  const raw = process.env.NETWORK_MONITOR_RANGES || "";

  return Array.from(
    new Set(
      raw
        .split(/[\s,;]+/)
        .map((item) => normalizeCidr(item))
        .filter((item): item is string => Boolean(item))
    )
  ).map((subnet) => ({ subnet, source: "configured" }));
}

export async function persistedConfiguredNetworkRanges(): Promise<NetworkRange[]> {
  await initDb();

  const rows = await all<{ subnet: string }>(
    "SELECT subnet FROM network_ranges WHERE agent_id=? AND source='configured' ORDER BY subnet ASC",
    [SERVER_CONFIG_AGENT_ID]
  );

  return rows
    .map((row) => normalizeCidr(row.subnet))
    .filter((item): item is string => Boolean(item))
    .map((subnet) => ({ subnet, source: "configured" }));
}

export async function saveConfiguredNetworkRanges(ranges: string[]): Promise<string[]> {
  await initDb();

  const normalized = Array.from(new Set(ranges.map(normalizeCidr).filter((item): item is string => Boolean(item))));
  const now = new Date().toISOString();

  await run("DELETE FROM network_ranges WHERE agent_id=? AND source='configured'", [SERVER_CONFIG_AGENT_ID]);

  for (const subnet of normalized) {
    await run(
      "INSERT INTO network_ranges(agent_id,subnet,source,first_seen,last_seen) VALUES(?,?,?,?,?)",
      [SERVER_CONFIG_AGENT_ID, subnet, "configured", now, now]
    );
  }

  return normalized;
}

export function inputNetworkRanges(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\s,;]+/)
      : [];

  return Array.from(new Set(items.map(normalizeCidr).filter((item): item is string => Boolean(item))));
}
