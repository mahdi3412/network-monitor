"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Status = "online" | "recent" | "offline";

type Row = {
  agent_id: string;
  ip: string | null;
  mac: string | null;
  hostname: string | null;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  personnel_id: string | null;
  os_version: string | null;
  cpu: string | null;
  ram_mb: number | null;
  agent_version: string | null;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  bios_version: string | null;
  last_boot: string | null;
  disk_total_gb: number | null;
  disk_free_gb: number | null;
  domain: string | null;
  domain_joined: number | null;
  last_seen: string;
  created_at: string;
  status: Status;
  dup_ip: boolean;
  dup_mac: boolean;
  dup_host: boolean;
};

type Summary = { total: number; online: number; recent: number; offline: number; duplicates: number };
type Result = { items: Row[]; total: number; page: number; pageSize: number; summary: Summary };
type HistoryItem = { received_at: string; ip: string | null; hostname: string | null; username: string | null };

const STATUS_LABEL: Record<Status, string> = {
  online: "آنلاین",
  recent: "اخیراً دیده‌شده",
  offline: "آفلاین"
};

const COLUMNS: Array<{ key: string; label: string; sort?: string }> = [
  { key: "status", label: "وضعیت", sort: "last_seen" },
  { key: "hostname", label: "نام کامپیوتر", sort: "hostname" },
  { key: "ip", label: "IP", sort: "ip" },
  { key: "mac", label: "MAC", sort: "mac" },
  { key: "name", label: "نام و نام خانوادگی", sort: "name" },
  { key: "personnel_id", label: "پرسنلی", sort: "personnel_id" },
  { key: "username", label: "کاربر ویندوز", sort: "username" },
  { key: "os_version", label: "ویندوز", sort: "os_version" },
  { key: "last_seen", label: "آخرین زمان", sort: "last_seen" }
];

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("fa-IR");
}

function fullName(row: Row) {
  return [row.first_name, row.last_name].filter(Boolean).join(" ") || "-";
}

// فقط ردیف‌هایی که IP، نام یا کاربر نسبت به ردیف قدیمی‌تر تغییر کرده‌اند
function onlyChanges(history: HistoryItem[]) {
  const sorted = [...history].sort((a, b) => (a.received_at < b.received_at ? 1 : -1));
  return sorted.filter((item, index) => {
    const older = sorted[index + 1];
    if (!older) return true;
    return item.ip !== older.ip || item.hostname !== older.hostname || item.username !== older.username;
  });
}

const css = `
.inv{min-height:100vh;padding:20px;background:#0b1020;color:#e8ecf7;font-family:Arial,Tahoma,sans-serif}
.inv *{box-sizing:border-box}
.inv a{color:#8fb4ff;text-decoration:none}
.inv h1{margin:0 0 4px;font-size:22px}.inv .sub{color:#8f9bb7;margin:0 0 16px}
.inv .chips{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}
.inv .chip{background:#121a2d;border:1px solid #25304a;border-radius:12px;padding:10px 14px;cursor:pointer;min-width:120px}
.inv .chip.active{border-color:#4f86d6;background:#162544}
.inv .chip span{display:block;color:#8f9bb7;font-size:12px;margin-bottom:4px}.inv .chip b{font-size:20px}
.inv .bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
.inv input[type=text],.inv select{background:#0e1527;color:#fff;border:1px solid #30415f;border-radius:8px;padding:9px 10px;font-family:inherit}
.inv .search{flex:1;min-width:240px}
.inv label.check{display:flex;gap:6px;align-items:center;color:#9eabc6;font-size:14px}
.inv button,.inv a.btn{background:#31598f;color:#fff;border:0;border-radius:8px;padding:9px 14px;cursor:pointer;font-family:inherit;font-size:14px}
.inv button.secondary{background:#1c2a46}.inv button:disabled{opacity:.45;cursor:default}
.inv .wrap{overflow-x:auto;border:1px solid #25304a;border-radius:12px}
.inv table{width:100%;border-collapse:collapse;font-size:14px}
.inv th{background:#121a2d;color:#9eabc6;text-align:right;padding:10px;white-space:nowrap;cursor:pointer;user-select:none;position:sticky;top:0}
.inv td{padding:9px 10px;border-top:1px solid #1d2840;white-space:nowrap}
.inv tr.row{cursor:pointer}.inv tr.row:hover td{background:#101a30}
.inv .badge{padding:3px 9px;border-radius:999px;font-size:12px}
.inv .online{background:#123d2c;color:#63e6a6}.inv .recent{background:#3c3412;color:#f4d35e}.inv .offline{background:#3b1b24;color:#ff8798}
.inv .dup{display:inline-block;margin-inline-start:6px;padding:1px 7px;border-radius:6px;background:#4a2a12;color:#ffb36b;font-size:11px}
.inv .pager{display:flex;gap:10px;align-items:center;justify-content:space-between;margin-top:12px;color:#9eabc6;flex-wrap:wrap}
.inv .empty{padding:30px;text-align:center;color:#8f9bb7}.inv .error{color:#ff8798;margin:10px 0}
.inv .overlay{position:fixed;inset:0;background:rgba(5,8,18,.7);display:flex;justify-content:center;align-items:flex-start;padding:30px 16px;overflow:auto;z-index:20}
.inv .panel{background:#121a2d;border:1px solid #30415f;border-radius:14px;padding:20px;width:min(760px,100%)}
.inv .panel h2{margin:0 0 14px;font-size:18px;display:flex;justify-content:space-between;align-items:center}
.inv .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px}
.inv .item{background:#0e1527;border:1px solid #25304a;border-radius:10px;padding:10px}.inv .item span{display:block;color:#8f9bb7;font-size:12px;margin-bottom:4px}.inv .item b{word-break:break-word}
.inv .hist{width:100%;font-size:13px}.inv .hist td,.inv .hist th{padding:6px 8px;border-top:1px solid #1d2840;text-align:right}
.inv .tabs{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}
.inv .tab{padding:8px 14px;border-radius:10px;background:#121a2d;border:1px solid #25304a;color:#9eabc6}
.inv .tab.active{border-color:#4f86d6;background:#162544;color:#fff}
.inv{padding-bottom:70px}
@media(max-width:620px){.inv .grid{grid-template-columns:1fr}}
`;

export default function InventoryPage() {
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"all" | Status>("all");
  const [dupOnly, setDupOnly] = useState(false);
  const [sort, setSort] = useState("last_seen");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [selected, setSelected] = useState<Row | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const requestId = useRef(0);

  // جستجو با تأخیر کوتاه تا با هر کلید درخواست نرود
  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(qInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [qInput]);

  const buildParams = useCallback(() => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (status !== "all") params.set("status", status);
    if (dupOnly) params.set("dup", "1");
    params.set("sort", sort);
    params.set("dir", dir);
    return params;
  }, [q, status, dupOnly, sort, dir]);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    const params = buildParams();
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));
    try {
      const response = await fetch(`/api/inventory?${params.toString()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as Result;
      if (id !== requestId.current) return; // پاسخ قدیمی
      setResult(data);
      setError("");
    } catch (e) {
      if (id !== requestId.current) return;
      setError(e instanceof Error ? e.message : "خطا در دریافت اطلاعات");
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [buildParams, page, pageSize]);

  useEffect(() => {
    setLoading(true);
    load();
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setHistoryLoading(true);
    setHistory([]);
    fetch(`/api/clients/${encodeURIComponent(selected.agent_id)}`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : { history: [] }))
      .then((data) => {
        if (!cancelled) setHistory(Array.isArray(data.history) ? data.history : []);
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const toggleSort = (key?: string) => {
    if (!key) return;
    if (sort === key) setDir(dir === "asc" ? "desc" : "asc");
    else {
      setSort(key);
      setDir(key === "last_seen" ? "desc" : "asc");
    }
    setPage(1);
  };

  const pickStatus = (value: "all" | Status) => {
    setStatus(value);
    setDupOnly(false);
    setPage(1);
  };

  const exportUrl = `/api/inventory?${(() => {
    const params = buildParams();
    params.set("format", "csv");
    return params.toString();
  })()}`;

  const summary = result?.summary;
  const items = result?.items ?? [];
  const total = result?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const changes = onlyChanges(history);

  return (
    <div className="inv" dir="rtl">
      <style>{css}</style>

      <h1>موجودی سیستم‌ها</h1>
      <p className="sub">
        همه کامپیوترهایی که Agent دارند، با اطلاعات کاربر از Active Directory. <a href="/">بازگشت به داشبورد اصلی</a>
      </p>

      <div className="tabs">
        <a className="tab active" href="/inventory">سیستم‌های دارای Agent</a>
        <a className="tab" href="/inventory/unmanaged">دستگاه‌های بدون Agent</a>
      </div>

      <div className="chips">
        <div className={`chip ${status === "all" && !dupOnly ? "active" : ""}`} onClick={() => pickStatus("all")}>
          <span>کل</span>
          <b>{summary?.total ?? "-"}</b>
        </div>
        <div className={`chip ${status === "online" ? "active" : ""}`} onClick={() => pickStatus("online")}>
          <span>آنلاین</span>
          <b>{summary?.online ?? "-"}</b>
        </div>
        <div className={`chip ${status === "recent" ? "active" : ""}`} onClick={() => pickStatus("recent")}>
          <span>اخیراً دیده‌شده</span>
          <b>{summary?.recent ?? "-"}</b>
        </div>
        <div className={`chip ${status === "offline" ? "active" : ""}`} onClick={() => pickStatus("offline")}>
          <span>آفلاین</span>
          <b>{summary?.offline ?? "-"}</b>
        </div>
        <div
          className={`chip ${dupOnly ? "active" : ""}`}
          onClick={() => {
            setStatus("all");
            setDupOnly(!dupOnly);
            setPage(1);
          }}
        >
          <span>IP / MAC / نام تکراری</span>
          <b>{summary?.duplicates ?? "-"}</b>
        </div>
      </div>

      <div className="bar">
        <input
          className="search"
          type="text"
          placeholder="جستجو: IP، MAC، نام کامپیوتر، نام کاربر، پرسنلی، ویندوز ..."
          value={qInput}
          onChange={(event) => setQInput(event.target.value)}
        />
        <select
          value={pageSize}
          onChange={(event) => {
            setPageSize(Number(event.target.value));
            setPage(1);
          }}
        >
          <option value={25}>۲۵ ردیف</option>
          <option value={50}>۵۰ ردیف</option>
          <option value={100}>۱۰۰ ردیف</option>
          <option value={200}>۲۰۰ ردیف</option>
        </select>
        <a className="btn" href={exportUrl}>
          خروجی Excel (CSV)
        </a>
      </div>

      {error && <div className="error">خطا: {error}</div>}

      <div className="wrap">
        <table>
          <thead>
            <tr>
              {COLUMNS.map((column) => (
                <th key={column.key} onClick={() => toggleSort(column.sort)}>
                  {column.label}
                  {column.sort && sort === column.sort ? (dir === "asc" ? " ▲" : " ▼") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <tr key={row.agent_id} className="row" onClick={() => setSelected(row)}>
                <td>
                  <span className={`badge ${row.status}`}>{STATUS_LABEL[row.status]}</span>
                </td>
                <td>
                  {row.hostname || "-"}
                  {row.dup_host && <span className="dup">نام تکراری</span>}
                </td>
                <td>
                  {row.ip || "-"}
                  {row.dup_ip && <span className="dup">IP تکراری</span>}
                </td>
                <td>
                  {row.mac || "-"}
                  {row.dup_mac && <span className="dup">MAC تکراری</span>}
                </td>
                <td>{fullName(row)}</td>
                <td>{row.personnel_id || "-"}</td>
                <td>{row.username || "-"}</td>
                <td>{row.os_version || "-"}</td>
                <td>{formatDate(row.last_seen)}</td>
              </tr>
            ))}
            {!items.length && (
              <tr>
                <td colSpan={COLUMNS.length}>
                  <div className="empty">{loading ? "در حال بارگذاری..." : "موردی پیدا نشد."}</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="pager">
        <span>
          {total} مورد — صفحه {page} از {pages}
        </span>
        <span style={{ display: "flex", gap: 8 }}>
          <button className="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            قبلی
          </button>
          <button className="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            بعدی
          </button>
        </span>
      </div>

      {selected && (
        <div className="overlay" onClick={() => setSelected(null)}>
          <div className="panel" onClick={(event) => event.stopPropagation()}>
            <h2>
              <span>{selected.hostname || selected.agent_id}</span>
              <button className="secondary" onClick={() => setSelected(null)}>
                بستن
              </button>
            </h2>

            <div className="grid">
              <div className="item"><span>وضعیت</span><b>{STATUS_LABEL[selected.status]}</b></div>
              <div className="item"><span>آخرین زمان دیده‌شدن</span><b>{formatDate(selected.last_seen)}</b></div>
              <div className="item"><span>IP</span><b>{selected.ip || "-"}</b></div>
              <div className="item"><span>MAC</span><b>{selected.mac || "-"}</b></div>
              <div className="item"><span>نام و نام خانوادگی (AD)</span><b>{fullName(selected)}</b></div>
              <div className="item"><span>شماره پرسنلی</span><b>{selected.personnel_id || "-"}</b></div>
              <div className="item"><span>کاربر ویندوز</span><b>{selected.username || "-"}</b></div>
              <div className="item"><span>ویندوز</span><b>{selected.os_version || "-"}</b></div>
              <div className="item"><span>CPU</span><b>{selected.cpu || "-"}</b></div>
              <div className="item"><span>RAM</span><b>{selected.ram_mb ? `${Math.round(selected.ram_mb / 1024)} GB` : "-"}</b></div>
              <div className="item"><span>سازنده / مدل</span><b>{[selected.manufacturer, selected.model].filter(Boolean).join(" ") || "-"}</b></div>
              <div className="item"><span>شماره سریال</span><b>{selected.serial_number || "-"}</b></div>
              <div className="item"><span>نسخه BIOS</span><b>{selected.bios_version || "-"}</b></div>
              <div className="item"><span>آخرین بوت</span><b>{formatDate(selected.last_boot)}</b></div>
              <div className="item"><span>دیسک سیستم (آزاد / کل)</span><b>{selected.disk_total_gb ? `${selected.disk_free_gb ?? "-"} / ${selected.disk_total_gb} GB` : "-"}</b></div>
              <div className="item"><span>دامنه</span><b>{selected.domain ? `${selected.domain}${selected.domain_joined ? "" : " (عضو دامنه نیست)"}` : "-"}</b></div>
              <div className="item"><span>نسخه Agent</span><b>{selected.agent_version || "-"}</b></div>
              <div className="item"><span>اولین بار دیده شد</span><b>{formatDate(selected.created_at)}</b></div>
            </div>

            <strong>تاریخچه تغییرات (IP، نام کامپیوتر، کاربر)</strong>
            <div className="wrap" style={{ marginTop: 8 }}>
              <table className="hist">
                <thead>
                  <tr>
                    <th>زمان</th>
                    <th>IP</th>
                    <th>نام کامپیوتر</th>
                    <th>کاربر</th>
                  </tr>
                </thead>
                <tbody>
                  {changes.map((item, index) => (
                    <tr key={`${item.received_at}-${index}`}>
                      <td>{formatDate(item.received_at)}</td>
                      <td>{item.ip || "-"}</td>
                      <td>{item.hostname || "-"}</td>
                      <td>{item.username || "-"}</td>
                    </tr>
                  ))}
                  {!changes.length && (
                    <tr>
                      <td colSpan={4}>
                        <div className="empty">{historyLoading ? "در حال بارگذاری..." : "تاریخچه‌ای ثبت نشده است."}</div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
