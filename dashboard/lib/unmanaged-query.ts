import { statusCutoffs } from "./heartbeat-config";
import { ipSortExpr } from "./inventory-query";

// دستگاه‌هایی که اسکن سرور دیده ولی Agent ندارند (چاپگر، سویچ، سیستم‌های بدون Agent و ...).
// یک میزبان «بدون Agent» است اگر هیچ کلاینتی با همین IP (در زمان اخیر)، MAC یا نام کامپیوتر نداشته باشد.
// این فایل فقط SQL و آرگومان‌ها را می‌سازد.

export const SERVER_SCAN_AGENT_ID = "__server__";

export type UnmanagedQuery = {
  csv: boolean;
  page: number;
  pageSize: number;
  days: number;
  listSql: string;
  listArgs: unknown[];
  countSql: string;
  countArgs: unknown[];
  typesSql: string;
  typesArgs: unknown[];
};

const SORTS: Record<string, string> = {
  last_seen: "last_seen",
  first_seen: "first_seen",
  ip: ipSortExpr("COALESCE(ip,'')"),
  hostname: "lower(COALESCE(hostname,''))",
  mac: "COALESCE(mac,'')",
  device_type: "COALESCE(device_type,'')",
  subnet: "COALESCE(subnet,'')",
  username: "lower(COALESCE(username,''))"
};

const SEARCH_COLUMNS = [
  "COALESCE(h.ip,'')",
  "COALESCE(h.hostname,'')",
  "COALESCE(h.mac,'')",
  "COALESCE(h.username,'')",
  "COALESCE(h.device_type,'')",
  "COALESCE(h.subnet,'')",
  "COALESCE(h.services,'')"
];

const ESCAPE = "ESCAPE '\\'";

function likeParam(term: string) {
  return `%${term.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
}

function baseSql(where: string) {
  return (
    "SELECT h.ip,h.hostname,h.username,h.mac,h.subnet,h.device_type,h.services,h.latency_ms,h.first_seen,h.last_seen " +
    `FROM network_hosts h WHERE h.agent_id='${SERVER_SCAN_AGENT_ID}' AND h.reachable=1 AND h.last_seen>=? ` +
    // همان IP با یک Agent که اخیراً دیده شده
    "AND NOT EXISTS (SELECT 1 FROM clients c WHERE c.ip=h.ip AND c.last_seen>=?) " +
    // همان MAC
    "AND NOT EXISTS (SELECT 1 FROM clients c WHERE COALESCE(h.mac,'')<>'' AND lower(c.mac)=lower(h.mac)) " +
    // همان نام کامپیوتر (نام کوتاه، بدون پسوند دامنه)
    "AND NOT EXISTS (SELECT 1 FROM clients c WHERE COALESCE(h.hostname,'')<>'' AND lower(c.hostname)=lower(substr(h.hostname,1,instr(h.hostname||'.','.')-1))) " +
    where
  );
}

export function buildUnmanagedQuery(params: URLSearchParams, now = Date.now()): UnmanagedQuery {
  const q = (params.get("q") || "").trim().slice(0, 100);
  const terms = q.split(/\s+/).filter(Boolean).slice(0, 5);
  const days = Math.min(90, Math.max(1, Math.floor(Number(params.get("days")) || 3)));
  const type = (params.get("type") || "").trim().slice(0, 30);
  const sortKey = Object.prototype.hasOwnProperty.call(SORTS, params.get("sort") || "")
    ? (params.get("sort") as string)
    : "last_seen";
  const direction = params.get("dir") === "asc" ? "ASC" : "DESC";
  const csv = params.get("format") === "csv";
  const pageSize = Math.min(200, Math.max(10, Number(params.get("pageSize")) || 50));
  const page = Math.max(1, Math.floor(Number(params.get("page")) || 1));

  const since = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
  const recentClients = statusCutoffs(now).recent;

  const where: string[] = [];
  const whereArgs: unknown[] = [];

  for (const term of terms) {
    where.push("AND (" + SEARCH_COLUMNS.map((col) => `${col} LIKE ? ${ESCAPE}`).join(" OR ") + ")");
    for (let i = 0; i < SEARCH_COLUMNS.length; i++) whereArgs.push(likeParam(term));
  }

  if (type) {
    where.push("AND COALESCE(NULLIF(h.device_type,''),'unknown') = ?");
    whereArgs.push(type);
  }

  const baseArgs = [since, recentClients, ...whereArgs];
  const base = baseSql(where.join(" "));
  const order = `ORDER BY ${SORTS[sortKey]} ${direction}, ip ASC`;

  // شمارش به تفکیک نوع دستگاه (بدون فیلتر جستجو و نوع)
  const unfilteredBase = baseSql("");

  return {
    csv,
    page,
    pageSize,
    days,
    listSql: `SELECT * FROM (${base}) ${order} ${csv ? "LIMIT 20000" : "LIMIT ? OFFSET ?"}`,
    listArgs: csv ? baseArgs : [...baseArgs, pageSize, (page - 1) * pageSize],
    countSql: `SELECT COUNT(*) AS n FROM (${base})`,
    countArgs: baseArgs,
    typesSql: `SELECT COALESCE(NULLIF(device_type,''),'unknown') AS type, COUNT(*) AS n FROM (${unfilteredBase}) GROUP BY type ORDER BY n DESC`,
    typesArgs: [since, recentClients]
  };
}
