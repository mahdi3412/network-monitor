"use client";

import { useEffect, useMemo, useState } from "react";

type Client = {
  agent_id: string;
  ip: string;
  mac: string;
  hostname: string;
  username: string;
  first_name: string;
  last_name: string;
  personnel_id: string;
  os: string;
  os_version: string;
  cpu?: string;
  ram_mb?: number;
  gateway?: string;
  dns?: string;
  adapter?: string;
  agent_version?: string;
  last_seen: string;
  status: string;
};

type NetworkHost = {
  id: number;
  agent_id: string;
  ip: string;
  hostname: string;
  mac: string;
  adapter: string;
  subnet: string;
  method: string;
  device_type: string;
  services: string;
  latency_ms: number | null;
  reachable: number;
  scanned_at: string;
  first_seen: string;
  last_seen: string;
  agent_hostname?: string;
  agent_ip?: string;
  status: "online" | "recent" | "offline";
};

type NetworkRange = {
  subnet: string;
  source: string;
  first_seen: string | null;
  last_seen: string | null;
  host_count: number;
  online_hosts: number;
};

function faDate(value?: string | null) {
  return value ? new Date(value).toLocaleString("fa-IR") : "-";
}

function statusLabel(status: string) {
  return status === "online" ? "آنلاین" : status === "recent" ? "اخیراً دیده‌شده" : "آفلاین";
}

export default function Home() {
  const [clients, setClients] = useState<Client[]>([]);
  const [hosts, setHosts] = useState<NetworkHost[]>([]);
  const [ranges, setRanges] = useState<NetworkRange[]>([]);
  const [configuredRangesText, setConfiguredRangesText] = useState("");
  const [rangeMessage, setRangeMessage] = useState("");
  const [savingRanges, setSavingRanges] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [query, setQuery] = useState("");
  const [subnet, setSubnet] = useState("all");
  const [method, setMethod] = useState("all");
  const [status, setStatus] = useState("all");
  const [deviceType, setDeviceType] = useState("all");
  const [tab, setTab] = useState<"clients" | "network">("clients");
  const [detail, setDetail] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [clientsResponse, hostsResponse, rangesResponse, scanResponse] = await Promise.all([
        fetch("/api/clients", { cache: "no-store" }),
        fetch("/api/network-hosts", { cache: "no-store" }),
        fetch("/api/network-ranges", { cache: "no-store" }),
        fetch("/api/network-scan", { cache: "no-store" })
      ]);

      if (clientsResponse.ok) setClients(await clientsResponse.json());
      if (hostsResponse.ok) setHosts(await hostsResponse.json());
      if (rangesResponse.ok) setRanges(await rangesResponse.json());
      if (scanResponse.ok) setScanning(Boolean((await scanResponse.json()).scanning));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();

    fetch("/api/network-ranges?config=1", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        if (data?.ranges) setConfiguredRangesText(data.ranges.join("\n"));
      })
      .catch(() => {});

    const timer = setInterval(load, 10000);
    return () => clearInterval(timer);
  }, []);

  const filteredClients = useMemo(() => {
    const q = query.toLowerCase();
    return clients.filter((c) =>
      [c.ip, c.hostname, c.username, c.first_name, c.last_name, c.personnel_id, c.mac]
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }, [clients, query]);

  const subnets = useMemo(
    () => Array.from(new Set([
      ...ranges.map((r) => r.subnet),
      ...hosts.map((h) => h.subnet).filter(Boolean)
    ])).sort(),
    [ranges, hosts]
  );

  const filteredHosts = useMemo(() => {
    const q = query.toLowerCase();
    return hosts.filter((h) => {
      const text = [h.ip, h.hostname, h.mac, h.adapter, h.subnet, h.agent_hostname, h.agent_ip]
        .join(" ")
        .toLowerCase();

      return (
        text.includes(q) &&
        (subnet === "all" || h.subnet === subnet) &&
        (method === "all" || h.method === method) &&
        (status === "all" || h.status === status) &&
        (deviceType === "all" || h.device_type === deviceType)
      );
    });
  }, [hosts, query, subnet, method, status, deviceType]);

  const onlineHosts = hosts.filter((h) => h.status === "online").length;
  const recentHosts = hosts.filter((h) => h.status === "recent").length;
  const deviceTypeCounts = useMemo(
    () => hosts.reduce<Record<string, number>>((acc, h) => {
      const t = h.device_type || "unknown";
      acc[t] = (acc[t] || 0) + 1;
      return acc;
    }, {}),
    [hosts]
  );

  const configuredRangeCount = ranges.filter((r) => r.source === "configured").length;

  async function saveRanges() {
    setSavingRanges(true);
    setRangeMessage("");

    try {
      const response = await fetch("/api/network-ranges", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ranges: configuredRangesText })
      });
      const data = await response.json();

      if (!response.ok) {
        setRangeMessage(data?.invalid?.length ? `رنج نامعتبر: ${data.invalid.join(", ")}` : (data?.error || "ذخیره رنج‌ها ناموفق بود."));
        return;
      }

      setConfiguredRangesText((data.ranges || []).join("\n"));
      setRangeMessage("رنج‌ها ذخیره شدند؛ اسکن شبکه شروع شد.");

      setScanning(true);
      const scanResponse = await fetch("/api/network-scan", {
        method: "POST",
        cache: "no-store"
      });

      if (scanResponse.ok) {
        await load();
      } else {
        setRangeMessage("رنج‌ها ذخیره شدند، ولی شروع اسکن با خطا مواجه شد.");
      }
    } catch {
      setRangeMessage("ارتباط با سرور برای ذخیره رنج‌ها برقرار نشد.");
    } finally {
      setSavingRanges(false);
    }
  }

  async function openDetail(id: string) {
    const response = await fetch("/api/clients/" + encodeURIComponent(id), { cache: "no-store" });
    if (response.ok) setDetail(await response.json());
  }

  return (
    <main className="shell">
      <div className="topbar">
        <div className="brand">
          <h1>Network Monitor</h1>
          <p>مرکز مانیتورینگ کلاینت‌ها و اعضای شبکه</p>
        </div>
        <button className="refresh" onClick={load}>
          {loading ? "در حال بروزرسانی..." : "بروزرسانی"}
        </button>
      </div>

      <section className="grid">
        <div className="card">
          <span className="muted">کل کلاینت‌های Agent</span>
          <div className="stat">{clients.length}</div>
        </div>
        <div className="card">
          <span className="muted">کل اعضای کشف‌شده شبکه</span>
          <div className="stat">{hosts.length}</div>
        </div>
        <div className="card">
          <span className="muted">میزبان‌های فعال</span>
          <div className="stat">{onlineHosts}</div>
        </div>
        <div className="card">
          <span className="muted">رنج‌های شبکه</span>
          <div className="stat">{subnets.length}</div>
        </div>
        <div className="card">
          <span className="muted">Windows</span>
          <div className="stat">{deviceTypeCounts.windows || 0}</div>
        </div>
        <div className="card">
          <span className="muted">Printer</span>
          <div className="stat">{deviceTypeCounts.printer || 0}</div>
        </div>
        <div className="card">
          <span className="muted">Network Device</span>
          <div className="stat">{deviceTypeCounts["network-device"] || 0}</div>
        </div>
      </section>

      <section className="card">
        <div className="toolbar">
          <div className="tabs">
            <button className={tab === "clients" ? "tab active" : "tab"} onClick={() => setTab("clients")}>
              کلاینت‌ها
            </button>
            <button className={tab === "network" ? "tab active" : "tab"} onClick={() => setTab("network")}>
              Network Inventory
            </button>
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              tab === "network"
                ? "جستجو: IP، Hostname، MAC، Subnet..."
                : "جستجو: IP، نام کامپیوتر، پرسنلی، کاربر، MAC..."
            }
          />
        </div>

        {tab === "clients" ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>وضعیت</th>
                  <th>IP</th>
                  <th>کامپیوتر</th>
                  <th>کاربر</th>
                  <th>پرسنلی</th>
                  <th>سیستم‌عامل</th>
                  <th>آخرین اتصال</th>
                </tr>
              </thead>
              <tbody>
                {filteredClients.map((c) => (
                  <tr key={c.agent_id}>
                    <td>
                      <span className={"status " + c.status}>{statusLabel(c.status)}</span>
                    </td>
                    <td>{c.ip || "-"}</td>
                    <td>
                      <button className="link-button" onClick={() => openDetail(c.agent_id)}>
                        {c.hostname || "-"}
                      </button>
                    </td>
                    <td>{[c.first_name, c.last_name].filter(Boolean).join(" ") || c.username || "-"}</td>
                    <td>{c.personnel_id || "-"}</td>
                    <td>
                      {c.os} {c.os_version}
                    </td>
                    <td>{faDate(c.last_seen)}</td>
                  </tr>
                ))}
                {!filteredClients.length && (
                  <tr>
                    <td colSpan={7} className="muted">
                      هنوز کلاینتی ثبت نشده است.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <>
            <div className="range-settings">
              <div>
                <h3>رنج‌های IP برای اسکن سرور</h3>
                <p className="muted">
                  هر رنج را در یک خط وارد کن، مثال: 192.168.103.0/24
                </p>
              </div>

              <textarea
                className="range-textarea"
                value={configuredRangesText}
                onChange={(e) => setConfiguredRangesText(e.target.value)}
                placeholder={"192.168.103.0/24\n192.168.104.0/24\n10.10.20.0/24"}
                rows={6}
                dir="ltr"
              />

              <div className="range-actions">
                <button className="refresh" onClick={saveRanges} disabled={savingRanges}>
                  {savingRanges ? "در حال ذخیره و اسکن..." : "ذخیره رنج‌ها و شروع اسکن"}
                </button>
                <span className="muted">
                  {configuredRangeCount} رنج تنظیم‌شده · {scanning ? "اسکن در حال انجام است" : "اسکن متوقف است"}
                </span>
              </div>

              {rangeMessage && <p className="range-message">{rangeMessage}</p>}
            </div>

            <div className="range-health">
              <div className="inventory-summary">
                <span>{ranges.length} رنج شناخته‌شده</span>
                <span>{configuredRangeCount} رنج دستی</span>
                <span>{ranges.filter((r) => r.online_hosts > 0).length} رنج دارای میزبان فعال</span>
              </div>

              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>رنج</th>
                      <th>منبع</th>
                      <th>کل میزبان‌های دیده‌شده</th>
                      <th>فعال</th>
                      <th>آخرین مشاهده</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ranges.map((r) => (
                      <tr key={r.subnet}>
                        <td>{r.subnet}</td>
                        <td>{r.source === "configured" ? "تنظیم دستی" : r.source === "server-route" ? "Route سرور" : "مشاهده‌شده"}</td>
                        <td>{r.host_count}</td>
                        <td>{r.online_hosts}</td>
                        <td>{faDate(r.last_seen)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="filters">
              <select value={subnet} onChange={(e) => setSubnet(e.target.value)}>
                <option value="all">همه رنج‌ها</option>
                {subnets.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>

              <select value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="all">همه روش‌ها</option>
                <option value="icmp">ICMP</option>
                <option value="arp">ARP</option>
              </select>

              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="all">همه وضعیت‌ها</option>
                <option value="online">فعال</option>
                <option value="recent">اخیراً دیده‌شده</option>
                <option value="offline">قدیمی</option>
              </select>

              <select value={deviceType} onChange={(e) => setDeviceType(e.target.value)}>
                <option value="all">همه نوع دستگاه‌ها</option>
                <option value="windows">Windows</option>
                <option value="printer">Printer</option>
                <option value="network-device">Network Device</option>
                <option value="gateway">Gateway</option>
                <option value="linux-or-network">Linux / Network</option>
                <option value="unknown">Unknown</option>
              </select>
            </div>

            <div className="inventory-summary">
              <span>{filteredHosts.length} نتیجه</span>
              <span>{onlineHosts} فعال</span>
              <span>{recentHosts} اخیر</span>
              <span>{hosts.filter((h) => h.status === "offline").length} قدیمی</span>
            </div>

            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>وضعیت</th>
                    <th>IP</th>
                    <th>Hostname</th>
                    <th>MAC</th>
                    <th>Subnet</th>
                    <th>نوع</th>
                    <th>Services</th>
                    <th>روش</th>
                    <th>Latency</th>
                    <th>Agent</th>
                    <th>اولین مشاهده</th>
                    <th>آخرین مشاهده</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredHosts.map((h) => (
                    <tr key={h.agent_id + ":" + h.ip}>
                      <td>
                        <span className={"status " + h.status}>{statusLabel(h.status)}</span>
                      </td>
                      <td>{h.ip}</td>
                      <td>{h.hostname || "-"}</td>
                      <td>{h.mac || "-"}</td>
                      <td>{h.subnet || "-"}</td>
                      <td>{h.device_type || "unknown"}</td>
                      <td>{(() => { try { return h.services ? JSON.parse(h.services).join(", ") : "-"; } catch { return "-"; } })()}</td>
                      <td>{h.method === "arp" ? "ARP" : "ICMP"}</td>
                      <td>{h.latency_ms != null ? h.latency_ms + " ms" : "-"}</td>
                      <td>{h.agent_hostname || h.agent_ip || "-"}</td>
                      <td>{faDate(h.first_seen)}</td>
                      <td>{faDate(h.last_seen)}</td>
                    </tr>
                  ))}
                  {!filteredHosts.length && (
                    <tr>
                      <td colSpan={12} className="muted">
                        در این فیلتر نتیجه‌ای پیدا نشد.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {detail && (
        <section className="card detail">
          <div className="detail-head">
            <div>
              <h2>{detail.client.hostname}</h2>
              <p className="muted">
                {detail.client.ip || "-"} · {detail.client.status}
              </p>
            </div>
            <button className="refresh" onClick={() => setDetail(null)}>
              بستن
            </button>
          </div>

          <div className="detail-grid">
            <div><b>کاربر</b><span>{detail.client.username || "-"}</span></div>
            <div><b>پرسنلی</b><span>{detail.client.personnel_id || "-"}</span></div>
            <div><b>MAC</b><span>{detail.client.mac || "-"}</span></div>
            <div><b>Adapter</b><span>{detail.client.adapter || "-"}</span></div>
            <div><b>Gateway</b><span>{detail.client.gateway || "-"}</span></div>
            <div><b>DNS</b><span>{detail.client.dns || "-"}</span></div>
            <div><b>CPU</b><span>{detail.client.cpu || "-"}</span></div>
            <div><b>RAM</b><span>{detail.client.ram_mb ? detail.client.ram_mb + " MB" : "-"}</span></div>
            <div><b>Agent</b><span>{detail.client.agent_version || "-"}</span></div>
          </div>

          <h3>اعضای قابل مشاهده شبکه</h3>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>IP</th>
                  <th>MAC</th>
                  <th>نام میزبان</th>
                  <th>Subnet</th>
                  <th>Interface</th>
                  <th>روش</th>
                  <th>Latency</th>
                  <th>اولین مشاهده</th>
                  <th>آخرین مشاهده</th>
                </tr>
              </thead>
              <tbody>
                {(detail.networkHosts || []).map((h: any) => (
                  <tr key={h.ip}>
                    <td>{h.ip}</td>
                    <td>{h.mac || "-"}</td>
                    <td>{h.hostname || "-"}</td>
                    <td>{h.subnet || "-"}</td>
                    <td>{h.adapter || "-"}</td>
                    <td>{h.method === "arp" ? "ARP" : "ICMP"}</td>
                    <td>{h.latency_ms != null ? h.latency_ms + " ms" : "-"}</td>
                    <td>{faDate(h.first_seen)}</td>
                    <td>{faDate(h.last_seen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>آخرین Heartbeatها</h3>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>زمان</th>
                  <th>IP</th>
                  <th>Latency</th>
                  <th>کاربر</th>
                </tr>
              </thead>
              <tbody>
                {(detail.history || []).map((h: any) => (
                  <tr key={h.id || h.received_at}>
                    <td>{faDate(h.received_at)}</td>
                    <td>{h.ip || "-"}</td>
                    <td>{h.latency_ms != null ? h.latency_ms + " ms" : "-"}</td>
                    <td>{h.username || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
