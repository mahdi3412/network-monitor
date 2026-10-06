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
  username: string;
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
  directory_personnel_id?: string;
  directory_display_name?: string;
  directory_first_name?: string;
  directory_last_name?: string;
  directory_department?: string;
  directory_title?: string;
  directory_email?: string;
  directory_upn?: string;
  ad_computer_name?: string;
  ad_dns_host_name?: string;
  ad_operating_system?: string;
  ad_operating_system_version?: string;
  ad_computer_description?: string;
  ad_managed_by?: string;
  ad_computer_dn?: string;
  ad_matched?: number;
  ad_match_type?: "hostname" | "dns" | "dns-short" | null;
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

function methodLabel(method: string) {
  return method === "arp" ? "ARP" : method === "tcp" ? "TCP" : "ICMP";
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
  const [directoryUser, setDirectoryUser] = useState<any>(null);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [adConfig, setAdConfig] = useState<any>(null);
  const [adTesting, setAdTesting] = useState(false);
  const [adSyncing, setAdSyncing] = useState(false);
  const [adComputerSyncing, setAdComputerSyncing] = useState(false);
  const [adMessage, setAdMessage] = useState("");
  const [adDiagnostics, setAdDiagnostics] = useState<string[]>([]);
  const [adMatchDiagnostics, setAdMatchDiagnostics] = useState<any>(null);
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

    fetch("/api/directory", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => setAdConfig(data?.config || null))
      .catch(() => {});

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
      const text = [
        h.ip,
        h.hostname,
        h.username,
        h.mac,
        h.adapter,
        h.subnet,
        h.agent_hostname,
        h.agent_ip,
        h.directory_personnel_id,
        h.directory_display_name,
        h.directory_department,
        h.directory_title,
        h.ad_computer_name,
        h.ad_dns_host_name,
        h.ad_operating_system,
        h.ad_computer_description,
        h.ad_managed_by
      ].join(" ").toLowerCase();

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
        setRangeMessage(
          data?.invalid?.length
            ? `رنج نامعتبر: ${data.invalid.join(", ")}`
            : (data?.error || "ذخیره رنج‌ها ناموفق بود.")
        );
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

  async function testActiveDirectory() {
    setAdTesting(true);
    setAdMessage("");
    try {
      const response = await fetch("/api/directory?test=1", { cache: "no-store" });
      const data = await response.json();
      setAdConfig(data?.config || adConfig);
      setAdMessage(data?.ok ? "اتصال Active Directory موفق بود." : (data?.error || "اتصال به Active Directory ناموفق بود."));
    } catch {
      setAdMessage("امکان تست Active Directory وجود ندارد.");
    } finally {
      setAdTesting(false);
    }
  }

  async function syncActiveDirectoryComputers() {
    setAdComputerSyncing(true);
    setAdMessage("");

    try {
      const response = await fetch("/api/directory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync-computers" })
      });
      const data = await response.json();

      if (response.ok && data?.ok) {
        setAdDiagnostics(Array.isArray(data.unmatchedDiagnostics) ? data.unmatchedDiagnostics : []);
        setAdMatchDiagnostics({
          matchMethodCounts: data.matchMethodCounts || {},
          matchSamples: data.matchSamples || {},
          ipMatchConflicts: data.ipMatchConflicts || 0,
          adDnsIpConflicts: data.adDnsIpConflicts || 0,
          adDnsIpConflictSamples: data.adDnsIpConflictSamples || [],
          adComputerMultiIpCount: data.adComputerMultiIpCount || 0,
          adComputerMultiIpDiagnostics: data.adComputerMultiIpDiagnostics || [],
          identityConflicts: data.identityConflicts || {},
          identityConflictSamples: data.identityConflictSamples || [],
          inventoryDnsIpConflicts: data.inventoryDnsIpConflicts || 0,
          inventoryDnsDiagnostics: data.inventoryDnsDiagnostics || [],
          unmatchedReasonCounts: data.unmatchedReasonCounts || {},
          unmatchedReasonSamples: data.unmatchedReasonSamples || {},
          deviceTypeDiagnostics: data.deviceTypeDiagnostics || [],
          inventoryAdOsDiagnostics: data.inventoryAdOsDiagnostics || [],
          inventoryClassificationDiagnostics: data.inventoryClassificationDiagnostics || [],
          windowsUnmatchedDiagnostics: data.windowsUnmatchedDiagnostics || [],
          windowsUnmatchedSamples: data.windowsUnmatchedSamples || [],
          agentAdDiagnostics: data.agentAdDiagnostics || [],
          eligibleInventoryHosts: data.eligibleInventoryHosts || 0,
          reservedInventoryHosts: data.reservedInventoryHosts || 0,
          adComputerIpv4Count: data.adComputerIpv4Count || 0,
          adComputerIpv4Samples: data.adComputerIpv4Samples || [],
          noHostnameAdIpDiagnostics: data.noHostnameAdIpDiagnostics || {
            adIpUnique: 0,
            adIpConflict: 0,
            adIpMissing: 0,
            adDnsResolvable: 0,
            adDnsMissing: 0,
            samples: []
          },
          adModuleDiagnostics: data.adModuleDiagnostics || null,
          duplicateAdNames: data.duplicateAdNames || [],
          adIpv4OverlapUnmatchedSamples: data.adIpv4OverlapUnmatchedSamples || [],
          adIpv4UniqueCount: data.adIpv4UniqueCount || 0,
          adIpv4InventoryOverlap: data.adIpv4InventoryOverlap || 0,
          adIpv4OutsideInventory: data.adIpv4OutsideInventory || 0,
          adIpv4Reserved: data.adIpv4Reserved || 0
        });
        setAdMessage(`همگام‌سازی AD: ${data.synced} سیستم · ذخیره: ${data.persistedComputers ?? 0} · رکورد DB: ${data.directoryComputerRows ?? 0} · Inventory: ${data.inventoryHosts ?? 0} · IP Match: ${data.ipMatches ?? 0} · نام: ${data.hostnameMatches ?? 0} · DNS: ${data.dnsMatches ?? 0} · DNS AD: ${data.adDnsWithName ?? 0} نام / ${data.adDnsSystemResolved ?? 0} سیستم / ${data.adDnsDirectResolved ?? 0} مستقیم از AD / ${data.adDnsUnresolved ?? 0} نامشخص · Subnet: ${(data.subnetDiagnostics || []).slice(0, 5).map((x: any) => `${x.subnet}=${x.total}/${x.ipMatches}`).join(", ") || "-"} · Device: ${(data.deviceTypeDiagnostics || []).map((x: any) => `${x.deviceType}=${x.total}/${x.ipMatches}`).join(", ") || "-"} · نمونه بدون Match: ${(data.unmatchedSamples || []).slice(0, 5).join(", ") || "-"}`);
        await load();
      } else {
        setAdMessage(data?.error || "همگام‌سازی کامپیوترهای AD ناموفق بود.");
      }
    } catch {
      setAdMessage("ارتباط با سرور برای همگام‌سازی کامپیوترهای AD برقرار نشد.");
    } finally {
      setAdComputerSyncing(false);
    }
  }

  async function syncActiveDirectoryUsers() {
    setAdSyncing(true);
    setAdMessage("");

    try {
      const response = await fetch("/api/directory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync-users" })
      });
      const data = await response.json();

      if (response.ok && data?.ok) {
        setAdMessage(`همگام‌سازی AD انجام شد: ${data.synced} کاربر`);
        await load();
      } else {
        setAdMessage(data?.error || "همگام‌سازی کاربران AD ناموفق بود.");
      }
    } catch {
      setAdMessage("ارتباط با سرور برای همگام‌سازی AD برقرار نشد.");
    } finally {
      setAdSyncing(false);
    }
  }

  async function openDetail(id: string) {
    const response = await fetch("/api/clients/" + encodeURIComponent(id), { cache: "no-store" });
    if (!response.ok) return;

    const data = await response.json();
    setDetail(data);
    setDirectoryUser(null);

    const personnelId = String(data?.client?.personnel_id || "").trim();
    if (!personnelId) return;

    setDirectoryLoading(true);
    try {
      const directoryResponse = await fetch(
        "/api/directory?personnelId=" + encodeURIComponent(personnelId),
        { cache: "no-store" }
      );
      if (directoryResponse.ok) {
        const directory = await directoryResponse.json();
        setDirectoryUser(directory?.user || null);
      }
    } finally {
      setDirectoryLoading(false);
    }
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
        <div className="card"><span className="muted">کل کلاینت‌های Agent</span><div className="stat">{clients.length}</div></div>
        <div className="card"><span className="muted">کل اعضای کشف‌شده شبکه</span><div className="stat">{hosts.length}</div></div>
        <div className="card"><span className="muted">میزبان‌های فعال</span><div className="stat">{onlineHosts}</div></div>
        <div className="card"><span className="muted">رنج‌های شبکه</span><div className="stat">{subnets.length}</div></div>
        <div className="card"><span className="muted">Windows</span><div className="stat">{deviceTypeCounts.windows || 0}</div></div>
        <div className="card"><span className="muted">Printer</span><div className="stat">{deviceTypeCounts.printer || 0}</div></div>
        <div className="card"><span className="muted">Network Device</span><div className="stat">{deviceTypeCounts["network-device"] || 0}</div></div>
      </section>

      <section className="card">
        <div className="toolbar">
          <div className="tabs">
            <button className={tab === "clients" ? "tab active" : "tab"} onClick={() => setTab("clients")}>کلاینت‌ها</button>
            <button className={tab === "network" ? "tab active" : "tab"} onClick={() => setTab("network")}>Network Inventory</button>
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              tab === "network"
                ? "جستجو: IP، Computer Name، Username، MAC، Subnet..."
                : "جستجو: IP، نام کامپیوتر، پرسنلی، کاربر، MAC..."
            }
          />
        </div>

        {tab === "clients" ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>وضعیت</th><th>IP</th><th>کامپیوتر</th><th>کاربر</th><th>پرسنلی</th><th>سیستم‌عامل</th><th>آخرین اتصال</th></tr>
              </thead>
              <tbody>
                {filteredClients.map((c) => (
                  <tr key={c.agent_id}>
                    <td><span className={"status " + c.status}>{statusLabel(c.status)}</span></td>
                    <td>{c.ip || "-"}</td>
                    <td><button className="link-button" onClick={() => openDetail(c.agent_id)}>{c.hostname || "-"}</button></td>
                    <td>{[c.first_name, c.last_name].filter(Boolean).join(" ") || c.username || "-"}</td>
                    <td>{c.personnel_id || "-"}</td>
                    <td>{c.os} {c.os_version}</td>
                    <td>{faDate(c.last_seen)}</td>
                  </tr>
                ))}
                {!filteredClients.length && <tr><td colSpan={7} className="muted">هنوز کلاینتی ثبت نشده است.</td></tr>}
              </tbody>
            </table>
          </div>
        ) : (
          <>
            <div className="range-settings">
              <div>
                <h3>رنج‌های IP برای اسکن سرور</h3>
                <p className="muted">هر رنج را در یک خط وارد کن، مثال: 192.168.103.0/24</p>
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
                <span className="muted">{configuredRangeCount} رنج تنظیم‌شده · {scanning ? "اسکن در حال انجام است" : "اسکن متوقف است"}</span>
              </div>
              {rangeMessage && <p className="range-message">{rangeMessage}</p>}
            </div>

            <div className="ad-status-card">
              <div>
                <h3>Active Directory</h3>
                <p className="muted">
                  {adConfig?.enabled ? (adConfig.ready ? "تنظیم شده" : "فعال ولی ناقص") : "غیرفعال"}
                  {adConfig?.server ? ` · ${adConfig.server}:${adConfig.port}` : ""}
                </p>
              </div>
              <div className="range-actions">
                <button className="refresh" onClick={testActiveDirectory} disabled={adTesting || !adConfig?.enabled}>
                  {adTesting ? "در حال تست..." : "تست اتصال AD"}
                </button>
                <button className="refresh" onClick={syncActiveDirectoryUsers} disabled={adSyncing || !adConfig?.ready}>
                  {adSyncing ? "در حال همگام‌سازی..." : "همگام‌سازی کاربران AD"}
                </button>
                <button className="refresh" onClick={syncActiveDirectoryComputers} disabled={adComputerSyncing || !adConfig?.ready}>
                  {adComputerSyncing ? "در حال همگام‌سازی..." : "همگام‌سازی کامپیوترهای AD"}
                </button>
              </div>
              {adMessage && <span className="muted">{adMessage}</span>}
              {adMatchDiagnostics && (
                <details className="ad-diagnostics">
                  <summary>تحلیل تطبیق AD</summary>
                  <div className="ad-diagnostics-list" dir="rtl">
                    <div><b>میزبان قابل بررسی:</b> {adMatchDiagnostics.eligibleInventoryHosts} · <b>رزرو شده:</b> {adMatchDiagnostics.reservedInventoryHosts}</div>
                    <div><b>روش تطبیق:</b> IP={adMatchDiagnostics.matchMethodCounts.ip || 0} · نام={adMatchDiagnostics.matchMethodCounts.hostname || 0} · DNS={adMatchDiagnostics.matchMethodCounts.dns || 0} · MAC+نام={adMatchDiagnostics.matchMethodCounts.macHostname || 0} · <b>Conflict IP:</b> {adMatchDiagnostics.ipMatchConflicts} · <b>AD DNS چندنامی:</b> {adMatchDiagnostics.adDnsIpConflicts} · <b>یک AD با چند IP:</b> {adMatchDiagnostics.adComputerMultiIpCount} · <b>Conflict هویت:</b> MAC/IP={adMatchDiagnostics.identityConflicts.macVsIp || 0} · MAC/نام={adMatchDiagnostics.identityConflicts.macVsHostname || 0} · <b>DNS/IP ناسازگار:</b> {adMatchDiagnostics.inventoryDnsIpConflicts || 0}</div>
                    <div><b>علت‌های بدون Match:</b> {Object.entries(adMatchDiagnostics.unmatchedReasonCounts || {}).map(([key, value]) => `${key}=${value}`).join(" · ") || "-"}</div>
                    <div><b>تحلیل noHostname:</b> AD-IP یکتا={adMatchDiagnostics.noHostnameAdIpDiagnostics?.adIpUnique || 0} · AD-IP متعارض={adMatchDiagnostics.noHostnameAdIpDiagnostics?.adIpConflict || 0} · AD-IP ندارد={adMatchDiagnostics.noHostnameAdIpDiagnostics?.adIpMissing || 0} · AD-DNS قابل تطبیق={adMatchDiagnostics.noHostnameAdIpDiagnostics?.adDnsResolvable || 0} · AD-DNS بدون تطبیق={adMatchDiagnostics.noHostnameAdIpDiagnostics?.adDnsMissing || 0}</div>
                    <div><b>Get-ADComputer IPv4:</b> module={adMatchDiagnostics.adModuleDiagnostics?.moduleLoaded ? "OK" : "FAIL"} · query={adMatchDiagnostics.adModuleDiagnostics?.querySucceeded ? "OK" : "FAIL"} · scanned={adMatchDiagnostics.adModuleDiagnostics?.scanned || 0} · IPv4={adMatchDiagnostics.adModuleDiagnostics?.withIpv4 || 0} · بدون IPv4={adMatchDiagnostics.adModuleDiagnostics?.withoutIpv4 || 0} · indexed={adMatchDiagnostics.adModuleDiagnostics?.indexedKeys || 0}</div>
                    <div><b>پوشش IP AD نسبت به Inventory:</b> یکتا={adMatchDiagnostics.adIpv4UniqueCount || 0} · مشترک با Inventory={adMatchDiagnostics.adIpv4InventoryOverlap || 0} · خارج از Inventory={adMatchDiagnostics.adIpv4OutsideInventory || 0} · رزرو شده={adMatchDiagnostics.adIpv4Reserved || 0}</div>
                    {adMatchDiagnostics.duplicateAdNames?.length > 0 && (
                      <>
                        <b>نام‌های تکراری در خروجی AD</b>
                        {adMatchDiagnostics.duplicateAdNames.map((item: any) => <div key={item.name} dir="ltr">[AD-DUPLICATE-NAME] {item.name} × {item.count}</div>)}
                      </>
                    )}
                    {adMatchDiagnostics.adIpv4OverlapUnmatchedSamples?.length > 0 && (
                      <>
                        <b>IPهای مشترک AD و Inventory که هنوز Match نشده‌اند</b>
                        {adMatchDiagnostics.adIpv4OverlapUnmatchedSamples.map((item: string) => <div key={item} dir="ltr">[AD-IP-OVERLAP-UNMATCHED] {item}</div>)}
                      </>
                    )}
                    {adMatchDiagnostics.adModuleDiagnostics?.errorMessage && <div dir="ltr">[AD-MODULE-ERROR] {adMatchDiagnostics.adModuleDiagnostics.errorType || ""}: {adMatchDiagnostics.adModuleDiagnostics.errorMessage}</div>}
                    <div><b>Device:</b> {(adMatchDiagnostics.deviceTypeDiagnostics || []).map((x: any) => `${x.deviceType}=${x.total}/${x.ipMatches}/${x.unmatched}`).join(" · ") || "-"}</div>
                    <hr />
                    {adMatchDiagnostics.adDnsIpConflictSamples?.length > 0 && (
                      <>
                        <b>نمونه IPهای دارای چند Computer در AD DNS</b>
                        {adMatchDiagnostics.adDnsIpConflictSamples.map((item: string) => <div key={item} dir="ltr">[AD-DNS-CONFLICT] {item}</div>)}
                      </>
                    )}
                    {adMatchDiagnostics.adComputerMultiIpDiagnostics?.length > 0 && (
                      <>
                        <b>Computerهای AD با چند IP در DNS</b>
                        {adMatchDiagnostics.adComputerMultiIpDiagnostics.slice(0, 20).map((item: any) => (
                          <div key={item.name} dir="ltr">[AD-MULTI-IP] {item.name} -> {item.ips.join(", ")}</div>
                        ))}
                      </>
                    )}
                    {adMatchDiagnostics.identityConflictSamples?.length > 0 && (
                      <>
                        {adMatchDiagnostics.inventoryDnsDiagnostics?.length > 0 && (
                      <>
                        {adMatchDiagnostics.inventoryAdOsDiagnostics?.length > 0 && (
                      <>
                        {adMatchDiagnostics.windowsUnmatchedDiagnostics?.length > 0 && (
                      <>
                        <b>Agent ↔ AD</b>
                        {adMatchDiagnostics.agentAdDiagnostics?.slice(0, 30).map((item: any) => <div key={item.hostname + item.ip} dir="ltr">[AGENT-AD] {item.hostname || "-"} | IP={item.ip || "-"} | MAC={item.mac || "-"} | AD-name={item.adByName || "-"} | AD-IP={item.adByIp || "-"}</div>)}
                        <b>Windows بدون Match با AD</b>
                        {adMatchDiagnostics.windowsUnmatchedDiagnostics.map((item: any) => <div key={item.reason} dir="ltr">[WIN-UNMATCHED] {item.reason} | {item.total}</div>)}
                        {adMatchDiagnostics.windowsUnmatchedSamples?.slice(0, 20).map((item: string) => <div key={item} dir="ltr">{item}</div>)}
                      </>
                    )}
                    <b>طبقه‌بندی نهایی Inventory</b>
                        <b>پوشش IPv4 کامپیوترهای AD</b>
                        <div dir="ltr">[AD-IP-COVERAGE] {adMatchDiagnostics.adComputerIpv4Count || 0} computer records with usable IPv4</div>
                        {adMatchDiagnostics.adComputerIpv4Samples?.slice(0, 10).map((item: string) => <div key={item} dir="ltr">{item}</div>)}
                        {adMatchDiagnostics.inventoryClassificationDiagnostics?.map((item: any) => <div key={item.classification} dir="ltr">[CLASS] {item.classification} | total={item.total} | match={item.matches} | unmatched={item.unmatched}</div>)}
                        <b>ارتباط Device با OS در AD</b>
                        {adMatchDiagnostics.inventoryAdOsDiagnostics.map((item: any) => <div key={item.operatingSystem} dir="ltr">[AD-OS] {item.operatingSystem} | total={item.total} | match={item.matches} | unmatched={item.unmatched}</div>)}
                      </>
                    )}
                    <b>نمونه DNS/IP ناسازگار</b>
                        {adMatchDiagnostics.inventoryDnsDiagnostics.slice(0, 20).map((item: any) => <div key={item.ip + item.hostname} dir="ltr">[DNS-IP] {item.ip} | {item.hostname} | DNS: {item.resolvedIps.join(", ")}</div>)}
                      </>
                    )}
                    <b>نمونه Conflict هویت</b>
                        {adMatchDiagnostics.identityConflictSamples.map((item: string) => <div key={item} dir="ltr">[IDENTITY-CONFLICT] {item}</div>)}
                      </>
                    )}
                    <b>نمونه‌های Match</b>
                    {Object.entries(adMatchDiagnostics.matchSamples || {}).flatMap(([method, samples]: any) => (samples || []).map((item: string) => (
                      <div key={`${method}-${item}`} dir="ltr">[{method}] {item}</div>
                    )))}
                    <b>نمونه‌های بدون Match</b>
                    {Object.entries(adMatchDiagnostics.unmatchedReasonSamples || {}).flatMap(([reason, samples]: any) => (samples || []).map((item: string) => (
                      <div key={`${reason}-${item}`} dir="ltr">[{reason}] {item}</div>
                    )))}
                  </div>
                </details>
              )}
              {adDiagnostics.length > 0 && (
                <details className="ad-diagnostics">
                  <summary>جزئیات خام بدون تطبیق AD ({adDiagnostics.length})</summary>
                  <div className="ad-diagnostics-list" dir="ltr">
                    {adDiagnostics.map((item, index) => <div key={index}>{item}</div>)}
                  </div>
                </details>
              )}
            </div>

            <div className="inventory-help">
              <b>راهنمای ستون‌ها:</b>
              <span><strong>Latency</strong> زمان تقریبی رفت‌وبرگشت پاسخ شبکه از سرور تا IP است؛ عدد کمتر معمولاً یعنی مسیر سریع‌تر.</span>
              <span><strong>Computer Name</strong> نام سیستم است؛ اول از Inventory، سپس از Agent و در صورت تطبیق از نام/DNS کامپیوتر AD تکمیل می‌شود.</span>
              <span><strong>Username</strong> ابتدا از Inventory و در صورت خالی بودن برای Agentها از اطلاعات خود Agent تکمیل می‌شود.</span>
              <span><strong>AD Match</strong> نشان می‌دهد این IP با رکورد کامپیوتر در AD تطبیق داده شده؛ «نام» بر اساس نام کامپیوتر و «DNS» بر اساس FQDN است.</span>
              <span><strong>اطلاعات AD</strong> بعد از همگام‌سازی کاربران AD، Username یا شماره پرسنلی به حساب AD وصل می‌شود و نام کاربر، پرسنلی، واحد، سمت و ایمیل قابل نمایش و جستجو است.</span>
              <span><strong>MAC</strong> شناسه سخت‌افزاری کارت شبکه است؛ برای رنج‌های پشت روتر معمولاً از خود سرور قابل مشاهده نیست.</span>
              <span><strong>Method</strong> مشخص می‌کند IP با ICMP، ARP یا TCP پیدا شده است.</span>
            </div>

            <div className="range-health">
              <div className="inventory-summary">
                <span>{ranges.length} رنج شناخته‌شده</span>
                <span>{configuredRangeCount} رنج دستی</span>
                <span>{ranges.filter((r) => r.online_hosts > 0).length} رنج دارای میزبان فعال</span>
              </div>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>رنج</th><th>منبع</th><th>کل میزبان‌های دیده‌شده</th><th>فعال</th><th>آخرین مشاهده</th></tr></thead>
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
                {subnets.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
              <select value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="all">همه روش‌ها</option>
                <option value="icmp">ICMP</option>
                <option value="arp">ARP</option>
                <option value="tcp">TCP</option>
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
              <span>{hosts.filter((h) => h.ad_matched).length} متصل به AD</span>
              <span>{hosts.filter((h) => !h.ad_matched).length} بدون تطبیق AD</span>
            </div>

            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>وضعیت</th><th>AD Match</th><th>IP</th><th>Computer Name</th><th>Username</th><th>نام کاربر AD</th><th>پرسنلی</th><th>واحد</th><th>AD OS</th><th>AD DNS</th><th>MAC</th><th>Subnet</th>
                    <th>نوع</th><th>Services</th><th>روش</th><th>Latency</th><th>Agent</th><th>اولین مشاهده</th><th>آخرین مشاهده</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredHosts.map((h) => (
                    <tr key={h.agent_id + ":" + h.ip}>
                      <td><span className={"status " + h.status}>{statusLabel(h.status)}</span></td>
                      <td>
                        {h.ad_matched ? (
                          <span className="status online">متصل به AD · {h.ad_match_type === "dns" || h.ad_match_type === "dns-short" ? "DNS" : h.ad_match_type === "ip" ? "IP" : "نام"}</span>
                        ) : (
                          <span className="status offline">بدون تطبیق AD</span>
                        )}
                      </td>
                      <td>{h.ip}</td>
                      <td>{h.hostname || h.ad_computer_name || h.ad_dns_host_name || "-"}</td>
                      <td>{h.username || "-"}</td>
                      <td>{h.directory_display_name || "-"}</td>
                      <td>{h.directory_personnel_id || "-"}</td>
                      <td>{h.directory_department || "-"}</td>
                      <td>{h.ad_operating_system || "-"}</td>
                      <td>{h.ad_dns_host_name || "-"}</td>
                      <td>{h.mac || "-"}</td>
                      <td>{h.subnet || "-"}</td>
                      <td>{h.device_type || "unknown"}</td>
                      <td>{(() => { try { return h.services ? JSON.parse(h.services).join(", ") : "-"; } catch { return "-"; } })()}</td>
                      <td>{methodLabel(h.method)}</td>
                      <td>{h.latency_ms != null ? h.latency_ms + " ms" : "-"}</td>
                      <td>{h.agent_hostname || h.agent_ip || "-"}</td>
                      <td>{faDate(h.first_seen)}</td>
                      <td>{faDate(h.last_seen)}</td>
                    </tr>
                  ))}
                  {!filteredHosts.length && <tr><td colSpan={19} className="muted">در این فیلتر نتیجه‌ای پیدا نشد.</td></tr>}
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
              <p className="muted">{detail.client.ip || "-"} · {detail.client.status}</p>
            </div>
            <button className="refresh" onClick={() => { setDetail(null); setDirectoryUser(null); }}>بستن</button>
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

          <div className="directory-card">
            <h3>اطلاعات Active Directory</h3>
            {directoryLoading ? (
              <p className="muted">در حال جستجو با شماره پرسنلی...</p>
            ) : directoryUser ? (
              <div className="detail-grid compact">
                <div><b>AD Username</b><span>{directoryUser.username || "-"}</span></div>
                <div><b>نام AD</b><span>{directoryUser.displayName || "-"}</span></div>
                <div><b>UPN</b><span>{directoryUser.userPrincipalName || "-"}</span></div>
                <div><b>Department</b><span>{directoryUser.department || "-"}</span></div>
                <div><b>Title</b><span>{directoryUser.title || "-"}</span></div>
                <div><b>Email</b><span>{directoryUser.email || "-"}</span></div>
              </div>
            ) : (
              <p className="muted">برای این شماره پرسنلی رکوردی از AD پیدا نشد یا اتصال AD هنوز تنظیم نشده است.</p>
            )}
          </div>

          <h3>اعضای قابل مشاهده شبکه</h3>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>IP</th><th>MAC</th><th>نام میزبان</th><th>Username</th><th>Subnet</th><th>Interface</th><th>روش</th><th>Latency</th><th>اولین مشاهده</th><th>آخرین مشاهده</th></tr></thead>
              <tbody>
                {(detail.networkHosts || []).map((h: any) => (
                  <tr key={h.ip}>
                    <td>{h.ip}</td><td>{h.mac || "-"}</td><td>{h.hostname || "-"}</td><td>{h.username || "-"}</td><td>{h.subnet || "-"}</td>
                    <td>{h.adapter || "-"}</td><td>{methodLabel(h.method)}</td><td>{h.latency_ms != null ? h.latency_ms + " ms" : "-"}</td>
                    <td>{faDate(h.first_seen)}</td><td>{faDate(h.last_seen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>آخرین Heartbeatها</h3>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>زمان</th><th>IP</th><th>Latency</th><th>کاربر</th></tr></thead>
              <tbody>
                {(detail.history || []).map((h: any) => (
                  <tr key={h.id || h.received_at}>
                    <td>{faDate(h.received_at)}</td><td>{h.ip || "-"}</td><td>{h.latency_ms != null ? h.latency_ms + " ms" : "-"}</td><td>{h.username || "-"}</td>
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
