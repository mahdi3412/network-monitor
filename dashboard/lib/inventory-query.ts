import { statusCutoffs } from "./heartbeat-config";

// ساخت کوئری‌های موجودی (جستجو، فیلتر، مرتب‌سازی، صفحه‌بندی، تکراری‌ها).
// این فایل به دیتابیس وصل نیست و فقط SQL و آرگومان‌ها را می‌سازد.

export type InventoryQuery = {
  csv: boolean;
  page: number;
  pageSize: number;
  listSql: string;
  listArgs: unknown[];
  countSql: string;
  countArgs: unknown[];
};

// مرتب‌سازی IP به‌صورت عددی (۱۰.۰.۰.۲ قبل ۱۰.۰.۰.۱۰)
export function ipSortExpr(col: string) {
  const r1 = `substr(${col},instr(${col},'.')+1)`;
  const r2 = `substr(${r1},instr(${r1},'.')+1)`;
  const r3 = `substr(${r2},instr(${r2},'.')+1)`;
  const a = `CAST(substr(${col},1,instr(${col},'.')-1) AS INTEGER)`;
  const b = `CAST(substr(${r1},1,instr(${r1},'.')-1) AS INTEGER)`;
  const c = `CAST(substr(${r2},1,instr(${r2},'.')-1) AS INTEGER)`;
  const d = `CAST(${r3} AS INTEGER)`;
  return `(${a}*16777216+${b}*65536+${c}*256+${d})`;
}

const SORTS: Record<string, string> = {
  last_seen: "last_seen",
  hostname: "lower(COALESCE(hostname,''))",
  ip: ipSortExpr("COALESCE(ip,'')"),
  mac: "COALESCE(mac,'')",
  username: "lower(COALESCE(username,''))",
  name: "lower(COALESCE(last_name,'')||' '||COALESCE(first_name,''))",
  personnel_id: "COALESCE(personnel_id,'')",
  os_version: "lower(COALESCE(os_version,''))"
};

const SEARCH_COLUMNS = [
  "COALESCE(c.ip,'')",
  "COALESCE(c.mac,'')",
  "COALESCE(c.hostname,'')",
  "COALESCE(c.username,'')",
  "COALESCE(c.personnel_id,'')",
  "COALESCE(c.os_version,'')",
  "(COALESCE(c.first_name,'')||' '||COALESCE(c.last_name,''))",
  "COALESCE(c.model,'')",
  "COALESCE(c.manufacturer,'')",
  "COALESCE(c.serial_number,'')"
];

const ESCAPE = "ESCAPE '\\'";

function likeParam(term: string) {
  return `%${term.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
}

// ستون‌های نمایشی به‌همراه پرچم تکراری بودن IP / MAC / نام کامپیوتر
// (فقط نسبت به سیستم‌هایی که اخیراً دیده شده‌اند، تا رکوردهای قدیمی هشدار الکی ندهند)
function baseSql(where: string) {
  const dup = (col: string) =>
    `CASE WHEN COALESCE(c.${col},'')<>'' AND EXISTS (SELECT 1 FROM clients d WHERE d.${col}=c.${col} AND d.agent_id<>c.agent_id AND d.last_seen>=?) THEN 1 ELSE 0 END`;
  return (
    "SELECT c.id,c.agent_id,c.ip,c.mac,c.hostname,c.username,c.first_name,c.last_name,c.personnel_id," +
    "c.os,c.os_version,c.cpu,c.ram_mb,c.agent_version,c.last_seen,c.created_at," +
    "c.manufacturer,c.model,c.serial_number,c.bios_version,c.last_boot,c.disk_total_gb,c.disk_free_gb,c.domain,c.domain_joined," +
    `${dup("ip")} AS dup_ip,${dup("mac")} AS dup_mac,${dup("hostname")} AS dup_host ` +
    `FROM clients c ${where}`
  );
}

const DUP_FILTER = "WHERE (dup_ip=1 OR dup_mac=1 OR dup_host=1)";

export function buildInventoryQuery(params: URLSearchParams, now = Date.now()): InventoryQuery {
  const cutoffs = statusCutoffs(now);

  const q = (params.get("q") || "").trim().slice(0, 100);
  const terms = q.split(/\s+/).filter(Boolean).slice(0, 5);
  const status = params.get("status") || "all";
  const osFilter = (params.get("os") || "").trim().slice(0, 60);
  const dupOnly = params.get("dup") === "1";
  const sortKey = Object.prototype.hasOwnProperty.call(SORTS, params.get("sort") || "")
    ? (params.get("sort") as string)
    : "last_seen";
  const direction = params.get("dir") === "asc" ? "ASC" : "DESC";
  const csv = params.get("format") === "csv";
  const pageSize = Math.min(200, Math.max(10, Number(params.get("pageSize")) || 50));
  const page = Math.max(1, Math.floor(Number(params.get("page")) || 1));

  const where: string[] = [];
  const whereArgs: unknown[] = [];

  for (const term of terms) {
    const macTerm = term.replace(/-/g, ":").toUpperCase();
    where.push(
      "(" +
        SEARCH_COLUMNS.map((col) => `${col} LIKE ? ${ESCAPE}`).join(" OR ") +
        ` OR COALESCE(c.mac,'') LIKE ? ${ESCAPE})`
    );
    for (let i = 0; i < SEARCH_COLUMNS.length; i++) whereArgs.push(likeParam(term));
    whereArgs.push(likeParam(macTerm));
  }

  if (status === "online") {
    where.push("c.last_seen >= ?");
    whereArgs.push(cutoffs.online);
  } else if (status === "recent") {
    where.push("c.last_seen < ? AND c.last_seen >= ?");
    whereArgs.push(cutoffs.online, cutoffs.recent);
  } else if (status === "offline") {
    where.push("c.last_seen < ?");
    whereArgs.push(cutoffs.recent);
  }

  if (osFilter) {
    where.push(`COALESCE(c.os_version,'') LIKE ? ${ESCAPE}`);
    whereArgs.push(likeParam(osFilter));
  }

  const base = baseSql(where.length ? "WHERE " + where.join(" AND ") : "");
  const baseArgs = [cutoffs.recent, cutoffs.recent, cutoffs.recent, ...whereArgs];
  const outer = dupOnly ? DUP_FILTER : "";
  const order = `ORDER BY ${SORTS[sortKey]} ${direction}, agent_id ASC`;

  return {
    csv,
    page,
    pageSize,
    listSql: `SELECT * FROM (${base}) ${outer} ${order} ${csv ? "LIMIT 20000" : "LIMIT ? OFFSET ?"}`,
    listArgs: csv ? baseArgs : [...baseArgs, pageSize, (page - 1) * pageSize],
    countSql: `SELECT COUNT(*) AS n FROM (${base}) ${outer}`,
    countArgs: baseArgs
  };
}

// شمارش کل و وضعیت‌ها (بدون فیلتر)
export function summaryQuery(now = Date.now()) {
  const c = statusCutoffs(now);
  return {
    sql:
      "SELECT COUNT(*) AS total," +
      " SUM(CASE WHEN last_seen>=? THEN 1 ELSE 0 END) AS online," +
      " SUM(CASE WHEN last_seen<? AND last_seen>=? THEN 1 ELSE 0 END) AS recent FROM clients",
    args: [c.online, c.online, c.recent]
  };
}

// تعداد سیستم‌هایی که IP/MAC/نامشان تکراری است (بدون فیلتر)
export function duplicateCountQuery(now = Date.now()) {
  const c = statusCutoffs(now);
  return {
    sql: `SELECT COUNT(*) AS n FROM (${baseSql("")}) ${DUP_FILTER}`,
    args: [c.recent, c.recent, c.recent]
  };
}
