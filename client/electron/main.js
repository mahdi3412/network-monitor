const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const { execFile } = require("child_process");
const dns = require("dns");

// نسخه از client/package.json خوانده می‌شود (نسخه فایل exe هم از همین‌جاست)
let AGENT_VERSION = "2.0.0";
try { AGENT_VERSION = require("../package.json").version || AGENT_VERSION; } catch {}

const hiddenMode = process.argv.includes("--hidden");
// بدون پنجره، شتاب‌دهنده گرافیکی لازم نیست و مصرف منابع را کم می‌کند
if (hiddenMode) app.disableHardwareAcceleration();

// پوشه مشترک کل سیستم (همه کاربران ویندوز): شناسه و کلید ایجنت و تنظیمات سراسری.
// با این کار هر کامپیوتر فقط یک رکورد دارد، حتی اگر چند کاربر لاگین کنند.
// اسکریپت نصب این پوشه را با دسترسی لازم می‌سازد؛ اگر قابل نوشتن نبود از پوشه کاربر استفاده می‌شود.
const machineDir = process.env.ProgramData ? path.join(process.env.ProgramData, "NetworkMonitor") : "";
const userDir = app.getPath("userData");
const userConfigPath = path.join(userDir, "config.json");
const machineConfigPath = machineDir ? path.join(machineDir, "config.json") : "";

let cachedStateDir = null;
function stateDir() {
  if (cachedStateDir) return cachedStateDir;
  if (machineDir) {
    try {
      fs.mkdirSync(machineDir, { recursive: true });
      fs.accessSync(machineDir, fs.constants.W_OK);
      cachedStateDir = machineDir;
      return cachedStateDir;
    } catch {}
  }
  cachedStateDir = userDir;
  return cachedStateDir;
}

function readJsonFile(file) {
  try {
    // BOM احتمالی (فایل ساخته‌شده با PowerShell) حذف می‌شود
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return {};
  }
}

// نام، نام خانوادگی و شماره پرسنلی دیگر در ایجنت وارد نمی‌شوند؛
// سرور آن‌ها را بر اساس username کاربر لاگین‌شده از Active Directory پیدا می‌کند.
const defaults = {
  serverUrl: "http://localhost:3000",
  heartbeatSeconds: 60
};

let mainWindow = null;
let heartbeatTimer = null;
let networkInfo = { gateway: "", interfaceIp: "", dns: "" };
let osInfo = { version: "" };
let hardware = {};
let hardwareLoadedAt = 0;
const HARDWARE_REFRESH_MS = 6 * 60 * 60 * 1000;
let runtime = {
  connected: false,
  lastAttempt: null,
  lastSuccess: null,
  lastError: "",
  lastLatencyMs: null,
  nextHeartbeat: null,
  serverIntervalSeconds: null
};

/* ---------- ذخیره‌سازی محلی ---------- */

// خواندن مقدار ذخیره‌شده؛ اگر فقط در پوشه قدیمی کاربر باشد به پوشه مشترک منتقل می‌شود
function readState(name) {
  const primary = stateDir();
  for (const dir of [primary, userDir]) {
    try {
      const value = fs.readFileSync(path.join(dir, name), "utf8").replace(/^\uFEFF/, "").trim();
      if (!value) continue;
      if (dir !== primary) {
        try { fs.writeFileSync(path.join(primary, name), value, { flag: "wx" }); } catch {}
      }
      return value;
    } catch {}
  }
  return "";
}
function writeState(name, value) {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(path.join(stateDir(), name), value);
}

function getKey() {
  return readState("agent-key");
}
function saveKey(key) {
  if (key) writeState("agent-key", key);
}

// تنظیمات: پیش‌فرض < تنظیمات کاربر < تنظیمات سراسری (که اسکریپت نصب می‌نویسد)
// پس آدرس سرور را مدیر به‌صورت مرکزی کنترل می‌کند و کاربر نمی‌تواند عوضش کند.
function getConfig() {
  return {
    ...defaults,
    ...readJsonFile(userConfigPath),
    ...(machineConfigPath ? readJsonFile(machineConfigPath) : {})
  };
}
function saveConfig(config) {
  fs.mkdirSync(path.dirname(userConfigPath), { recursive: true });
  fs.writeFileSync(userConfigPath, JSON.stringify(config, null, 2));
}

// ساخت شناسه با فلگ wx: اگر هم‌زمان دو کاربر اولین‌بار اجرا کنند، فقط یک شناسه ساخته می‌شود
function getAgentId() {
  const existing = readState("agent-id");
  if (existing) return existing;
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(path.join(stateDir(), "agent-id"), id, { flag: "wx" });
    return id;
  } catch {
    return readState("agent-id") || id;
  }
}

/* ---------- ابزارهای سیستمی ---------- */

function run(cmd, args, timeout = 3000) {
  return new Promise(resolve => {
    execFile(cmd, args, { windowsHide: true, timeout }, (error, stdout) => {
      resolve(error ? "" : String(stdout || ""));
    });
  });
}

// Gateway و IP کارت شبکه‌ای که default route از آن عبور می‌کند (کمترین metric)
async function getDefaultRoute() {
  if (process.platform !== "win32") return { gateway: "", interfaceIp: "" };
  const out = await run("route", ["print", "-4"], 3000);
  let best = null;
  for (const line of out.split(/\r?\n/)) {
    const m = line.trim().match(/^0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+)/);
    if (!m) continue;
    const metric = Number(m[3]);
    if (!best || metric < best.metric) best = { gateway: m[1], interfaceIp: m[2], metric };
  }
  return best
    ? { gateway: best.gateway, interfaceIp: best.interfaceIp }
    : { gateway: "", interfaceIp: "" };
}

function getDnsServers() {
  try { return dns.getServers().join(", "); } catch { return ""; }
}

const VIRTUAL_NAME = /vethernet|vmware|virtualbox|vbox|hyper-v|loopback|hamachi|tap-|tailscale|wireguard|zerotier|docker|wsl|bluetooth|npcap/i;
const VIRTUAL_OUI = ["00:50:56", "00:0c:29", "00:05:69", "00:15:5d", "08:00:27", "0a:00:27"];

function isVirtualAdapter(n) {
  const mac = String(n.mac || "").toLowerCase();
  return VIRTUAL_NAME.test(n.name) || VIRTUAL_OUI.some(prefix => mac.startsWith(prefix));
}

function getNetworkInterfaces() {
  const result = [];
  for (const [name, items] of Object.entries(os.networkInterfaces())) {
    for (const n of items || []) {
      if (n.internal || n.family !== "IPv4" || !n.address) continue;
      if (n.address.startsWith("169.254.")) continue; // APIPA
      result.push({ ...n, name });
    }
  }
  return result;
}

// کارت اصلی: اول کارت default route، بعد اولین کارت غیرمجازی، در نهایت اولین کارت
function pickPrimary(nets) {
  return (
    nets.find(n => networkInfo.interfaceIp && n.address === networkInfo.interfaceIp) ||
    nets.find(n => !isVirtualAdapter(n)) ||
    nets[0] ||
    {}
  );
}

// نام و نسخه واقعی ویندوز از رجیستری (مثلاً: Windows 11 Pro 23H2 (build 22631.4602))
async function loadOsInfo() {
  if (process.platform !== "win32") {
    osInfo = { version: `${os.type()} ${os.release()}` };
    return;
  }
  const out = await run("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"], 4000);
  const get = key => {
    const m = out.match(new RegExp("^\\s*" + key + "\\s+REG_\\w+\\s+(.+)$", "mi"));
    return m ? m[1].trim() : "";
  };
  let product = get("ProductName");
  const build = Number(get("CurrentBuildNumber") || get("CurrentBuild")) || 0;
  const display = get("DisplayVersion") || get("ReleaseId");
  const ubrRaw = get("UBR");
  const ubr = ubrRaw ? Number(ubrRaw) : NaN; // مقدار hex مثل 0x1a2b هم توسط Number پشتیبانی می‌شود

  // ویندوز ۱۱ هنوز ProductName را «Windows 10 ...» ثبت می‌کند
  if (build >= 22000) product = product.replace(/Windows 10/i, "Windows 11");

  const name = [product || `Windows ${os.release()}`, display].filter(Boolean).join(" ");
  const buildText = build ? `${build}${Number.isFinite(ubr) ? "." + ubr : ""}` : "";
  osInfo = { version: buildText ? `${name} (build ${buildText})` : name };
}

// مشخصات سخت‌افزار (سازنده، مدل، سریال، BIOS، آخرین بوت، دیسک، دامنه) با یک فراخوانی PowerShell.
// هر ۶ ساعت یک‌بار تازه می‌شود؛ اسکریپت با -EncodedCommand ارسال می‌شود تا مشکل quote نداشته باشد.
const HARDWARE_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$cs=Get-CimInstance Win32_ComputerSystem",
  "$bios=Get-CimInstance Win32_BIOS",
  "$os=Get-CimInstance Win32_OperatingSystem",
  "$d=Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DeviceID -eq $env:SystemDrive }",
  "[pscustomobject]@{",
  "manufacturer=$cs.Manufacturer;model=$cs.Model;domain=$cs.Domain;partOfDomain=[bool]$cs.PartOfDomain;",
  "serial=$bios.SerialNumber;biosVersion=$bios.SMBIOSBIOSVersion;",
  "lastBoot=$os.LastBootUpTime.ToUniversalTime().ToString('o');",
  "diskTotalGb=[math]::Round($d.Size/1GB,1);diskFreeGb=[math]::Round($d.FreeSpace/1GB,1)",
  "} | ConvertTo-Json -Compress"
].join("\n");

async function loadHardware() {
  if (process.platform !== "win32") return;
  const encoded = Buffer.from(HARDWARE_SCRIPT, "utf16le").toString("base64");
  const out = await run("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], 20000);
  try {
    const parsed = JSON.parse(out.trim());
    if (parsed && typeof parsed === "object") hardware = parsed;
  } catch {}
  hardwareLoadedAt = Date.now();
}

async function refreshNetworkInfo() {
  const route = await getDefaultRoute();
  networkInfo.gateway = route.gateway;
  networkInfo.interfaceIp = route.interfaceIp;
  networkInfo.dns = getDnsServers();
}

/* ---------- جمع‌آوری اطلاعات ---------- */

function collect() {
  const primary = pickPrimary(getNetworkInterfaces());
  return {
    agentId: getAgentId(),
    ip: primary.address || "",
    mac: String(primary.mac || "").toUpperCase(),
    adapter: primary.name || "",
    hostname: os.hostname(),
    // نام کاربری ویندوز (sAMAccountName) و دامنه؛ سرور از روی آن‌ها اطلاعات AD را پیدا می‌کند
    username: os.userInfo().username,
    domain: process.env.USERDOMAIN || "",
    os: process.platform,
    osVersion: osInfo.version,
    cpu: os.cpus()[0]?.model || "",
    ramMb: Math.round(os.totalmem() / 1024 / 1024),
    gateway: networkInfo.gateway,
    dns: networkInfo.dns,
    hardware,
    agentVersion: AGENT_VERSION
  };
}

function getState() {
  return { config: getConfig(), data: collect(), runtime: { ...runtime } };
}

function publish() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("agent-state", getState());
}

/* ---------- Heartbeat ---------- */

async function heartbeat() {
  const c = getConfig();
  const started = Date.now();
  runtime.lastAttempt = new Date().toISOString();
  runtime.lastError = "";
  publish();
  try {
    await refreshNetworkInfo();
    if (Date.now() - hardwareLoadedAt > HARDWARE_REFRESH_MS) await loadHardware();
    const response = await fetch(String(c.serverUrl).replace(/\/$/, "") + "/api/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json", ...(getKey() ? { "x-agent-key": getKey() } : {}) },
      body: JSON.stringify({ ...collect(), latencyMs: runtime.lastLatencyMs }),
      signal: AbortSignal.timeout(15000)
    });
    runtime.lastLatencyMs = Date.now() - started;
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error("HTTP " + response.status + (body ? " - " + body : ""));
    }
    const data = await response.json();
    if (data.agentKey) saveKey(data.agentKey);
    // فاصله heartbeat را سرور تعیین می‌کند (برای کنترل مرکزی بار در ۱۰۰۰ کلاینت)
    const serverInterval = Number(data.heartbeatSeconds);
    if (Number.isFinite(serverInterval) && serverInterval > 0) {
      runtime.serverIntervalSeconds = Math.min(600, Math.max(10, serverInterval));
    }
    runtime.connected = true;
    runtime.lastSuccess = new Date().toISOString();
  } catch (e) {
    runtime.connected = false;
    runtime.lastError = e?.message || "خطای ناشناخته";
  }
  scheduleHeartbeat();
  publish();
}

function scheduleHeartbeat() {
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  const base = runtime.serverIntervalSeconds || Math.max(10, Number(getConfig().heartbeatSeconds) || 60);
  // ±10% جابه‌جایی تصادفی تا ایجنت‌ها هم‌زمان درخواست نفرستند
  const seconds = base * (0.9 + Math.random() * 0.2);
  runtime.nextHeartbeat = new Date(Date.now() + seconds * 1000).toISOString();
  heartbeatTimer = setTimeout(heartbeat, seconds * 1000);
}

/* ---------- پنجره و IPC ---------- */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 620, height: 640, minWidth: 560, minHeight: 520,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, "ui.html"));
  mainWindow.on("closed", () => { mainWindow = null; });
}

ipcMain.handle("get-state", () => getState());
ipcMain.handle("save-config", (_, incoming) => {
  const current = getConfig();
  let serverUrl = String(incoming?.serverUrl || current.serverUrl).trim().replace(/\/$/, "");
  if (!/^https?:\/\//i.test(serverUrl)) serverUrl = "http://" + serverUrl;
  saveConfig({
    serverUrl,
    heartbeatSeconds: Math.max(10, Number(incoming?.heartbeatSeconds) || 60)
  });
  scheduleHeartbeat();
  heartbeat();
  return getState();
});
ipcMain.on("heartbeat-now", () => heartbeat());

/* ---------- چرخه عمر برنامه ---------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });

  app.whenReady().then(async () => {
    await loadOsInfo();
    await refreshNetworkInfo();
    // با --hidden ایجنت بدون پنجره و در پس‌زمینه اجرا می‌شود (برای استقرار با GPO)
    if (!hiddenMode) createWindow();
    // در حالت پس‌زمینه، شروع heartbeat با تأخیر تصادفی (تا ۳۰ ثانیه) تا بعد از راه‌اندازی هم‌زمان سیستم‌ها فشار ناگهانی به سرور نیاید
    if (hiddenMode) setTimeout(heartbeat, Math.random() * 30000);
    else heartbeat();
  });

  app.on("window-all-closed", () => {
    if (!hiddenMode && process.platform !== "darwin") app.quit();
  });
}
