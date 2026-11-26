"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Row = {
  ip: string;
  hostname: string | null;
  username: string | null;
  mac: string | null;
  subnet: string | null;
  device_type: string | null;
  services: string[];
  latency_ms: number | null;
  first_seen: string;
  last_seen: string;
  online: boolean;
};

type Result = {
  items: Row[];
  total: number;
  page: number;
  pageSize: number;
  days: number;
  types: Array<{ type: string; count: number }>;
};

const TYPE_LABEL: Record<string, string> = {
  windows: "ویندوز",
  printer: "چاپگر",
  "linux-or-network": "لینوکس / تجهیزات شبکه",
  unknown: "نامشخص"
};

const COLUMNS: Array<{ key: string; label: string; sort?: string }> = [
  { key: "online", label: "وضعیت", sort: "last_seen" },
  { key: "ip", label: "IP", sort: "ip" },
  { key: "hostname", label: "نام", sort: "hostname" },
  { key: "mac", label: "MAC", sort: "mac" },
  { key: "device_type", label: "نوع دستگاه", sort: "device_type" },
  { key: "services", label: "سرویس‌ها" },
  { key: "username", label: "کاربر", sort: "username" },
  { key: "subnet", label: "زیرشبکه", sort: "subnet" },
  { key: "first_seen", label: "اولین بار", sort: "first_seen" },
  { key: "last_seen", label: "آخرین بار", sort: "last_seen" }
];

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("fa-IR");
}

const css = `
.inv{min-height:100vh;padding:20px 20px 70px;background:#0b1020;color:#e8ecf7;font-family:Arial,Tahoma,sans-serif}
.inv *{box-sizing:border-box}
.inv a{color:#8fb4ff;text-decoration:none}
.inv h1{margin:0 0 4px;font-size:22px}.inv .sub{color:#8f9bb7;margin:0 0 16px}
.inv .tabs{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}
.inv .tab{padding:8px 14px;border-radius:10px;background:#121a2d;border:1px solid #25304a;color:#9eabc6}
.inv .tab.active{border-color:#4f86d6;background:#162544;color:#fff}
.inv .chips{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}
.inv .chip{background:#121a2d;border:1px solid #25304a;border-radius:12px;padding:10px 14px;cursor:pointer;min-width:120px}
.inv .chip.active{border-color:#4f86d6;background:#162544}
.inv .chip span{display:block;color:#8f9bb7;font-size:12px;margin-bottom:4px}.inv .chip b{font-size:20px}
.inv .bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
.inv input[type=text],.inv select{background:#0e1527;color:#fff;border:1px solid #30415f;border-radius:8px;padding:9px 10px;font-family:inherit}
.inv .search{flex:1;min-width:240px}
.inv button,.inv a.btn{background:#31598f;color:#fff;border:0;border-radius:8px;padding:9px 14px;cursor:pointer;font-family:inherit;font-size:14px}
.inv button.secondary{background:#1c2a46}.inv button:disabled{opacity:.45;cursor:default}
.inv .wrap{overflow-x:auto;border:1px solid #25304a;border-radius:12px}
.inv table{width:100%;border-collapse:collapse;font-size:14px}
.inv th{background:#121a2d;color:#9eabc6;text-align:right;padding:10px;white-space:nowrap;cursor:pointer;user-select:none}
.inv td{padding:9px 10px;border-top:1px solid #1d2840;white-space:nowrap}
.inv tr.row:hover td{background:#101a30}
.inv .badge{padding:3px 9px;border-radius:999px;font-size:12px}
.inv .on{background:#123d2c;color:#63e6a6}.inv .off{background:#3b1b24;color:#ff8798}
.inv .svc{display:inline-block;margin-inline-end:4px;padding:1px 7px;border-radius:6px;background:#1c2a46;color:#9eabc6;font-size:11px}
.inv .pager{display:flex;gap:10px;align-items:center;justify-content:space-between;margin-top:12px;color:#9eabc6;flex-wrap:wrap}
.inv .empty{padding:30px;text-align:center;color:#8f9bb7}.inv .error{color:#ff8798;margin:10px 0}
`;

export default function UnmanagedPage() {
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [days, setDays] = useState(3);
  const [sort, setSort] = useState("last_seen");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestId = useRef(0);

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
    if (type) params.set("type", type);
    params.set("days", String(days));
    params.set("sort", sort);
    params.set("dir", dir);
    return params;
  }, [q, type, days, sort, dir]);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    const params = buildParams();
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));
    try {
      const response = await fetch(`/api/inventory/unmanaged?${params.toString()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as Result;
      if (id !== requestId.current) return;
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
    const timer = setInterval(load, 60000);
    return () => clearInterval(timer);
  }, [load]);

  const toggleSort = (key?: string) => {
    if (!key) return;
    if (sort === key) setDir(dir === "asc" ? "desc" : "asc");
    else {
      setSort(key);
      setDir(key === "last_seen" || key === "first_seen" ? "desc" : "asc");
    }
    setPage(1);
  };

  const exportUrl = `/api/inventory/unmanaged?${(() => {
    const params = buildParams();
    params.set("format", "csv");
    return params.toString();
  })()}`;

  const items = result?.items ?? [];
  const total = result?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const types = result?.types ?? [];
  const allCount = types.reduce((sum, item) => sum + item.count, 0);

  return (
    <div className="inv" dir="rtl">
      <style>{css}</style>

      <h1>دستگاه‌های بدون Agent</h1>
      <p className="sub">
        دستگاه‌هایی که اسکن سرور دیده ولی Agent ندارند (چاپگر، تجهیزات شبکه، سیستم‌هایی که هنوز Agent نصب نشده).{" "}
        <a href="/">بازگشت به داشبورد اصلی</a>
      </p>

      <div className="tabs">
        <a className="tab" href="/inventory">سیستم‌های دارای Agent</a>
        <a className="tab active" href="/inventory/unmanaged">دستگاه‌های بدون Agent</a>
      </div>

      <div className="chips">
        <div
          className={`chip ${type === "" ? "active" : ""}`}
          onClick={() => {
            setType("");
            setPage(1);
          }}
        >
          <span>همه</span>
          <b>{result ? allCount : "-"}</b>
        </div>
        {types.map((item) => (
          <div
            key={item.type}
            className={`chip ${type === item.type ? "active" : ""}`}
            onClick={() => {
              setType(item.type);
              setPage(1);
            }}
          >
            <span>{TYPE_LABEL[item.type] || item.type}</span>
            <b>{item.count}</b>
          </div>
        ))}
      </div>

      <div className="bar">
        <input
          className="search"
          type="text"
          placeholder="جستجو: IP، نام، MAC، نوع، سرویس، زیرشبکه ..."
          value={qInput}
          onChange={(event) => setQInput(event.target.value)}
        />
        <select
          value={days}
          onChange={(event) => {
            setDays(Number(event.target.value));
            setPage(1);
          }}
        >
          <option value={1}>دیده‌شده در ۱ روز اخیر</option>
          <option value={3}>دیده‌شده در ۳ روز اخیر</option>
          <option value={7}>دیده‌شده در ۷ روز اخیر</option>
          <option value={30}>دیده‌شده در ۳۰ روز اخیر</option>
          <option value={90}>دیده‌شده در ۹۰ روز اخیر</option>
        </select>
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
              <tr key={row.ip} className="row">
                <td>
                  <span className={`badge ${row.online ? "on" : "off"}`}>{row.online ? "آنلاین" : "آفلاین"}</span>
                </td>
                <td>{row.ip}</td>
                <td>{row.hostname || "-"}</td>
                <td>{row.mac || "-"}</td>
                <td>{TYPE_LABEL[row.device_type || "unknown"] || row.device_type}</td>
                <td>
                  {row.services.length
                    ? row.services.map((service) => (
                        <span key={service} className="svc">
                          {service}
                        </span>
                      ))
                    : "-"}
                </td>
                <td>{row.username || "-"}</td>
                <td>{row.subnet || "-"}</td>
                <td>{formatDate(row.first_seen)}</td>
                <td>{formatDate(row.last_seen)}</td>
              </tr>
            ))}
            {!items.length && (
              <tr>
                <td colSpan={COLUMNS.length}>
                  <div className="empty">
                    {loading ? "در حال بارگذاری..." : "دستگاهی پیدا نشد. اگر اسکن سرور هنوز اجرا نشده، چند دقیقه صبر کنید."}
                  </div>
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
    </div>
  );
}
