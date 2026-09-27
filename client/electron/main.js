const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const { execFile } = require("child_process");
const dns = require("dns").promises;

const configPath = path.join(app.getPath("userData"), "config.json");
const keyPath = path.join(app.getPath("userData"), "agent-key");
const idPath = path.join(app.getPath("userData"), "agent-id");
const defaults = {
  serverUrl: "http://localhost:3000",
  firstName: "",
  lastName: "",
  personnelId: "",
  heartbeatSeconds: 30,
  agentVersion: "1.1.0"
};

let mainWindow = null;
let heartbeatTimer = null;
let networkHosts = [];
let runtime = {
  connected: false,
  lastAttempt: null,
  lastSuccess: null,
  lastError: "",
  lastLatencyMs: null,
  nextHeartbeat: null,
  scanning: false,
  lastScan: null,
  scanError: ""
};

function getKey() {
  try { return fs.readFileSync(keyPath, "utf8").trim(); } catch { return ""; }
}
function saveKey(key) {
  if (key) fs.writeFileSync(keyPath, key);
}
function getConfig() {
  try { return { ...defaults, ...JSON.parse(fs.readFileSync(configPath, "utf8")) }; }
  catch { return { ...defaults }; }
}
function saveConfig(config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}
function getAgentId() {
  try { return fs.readFileSync(idPath, "utf8").trim(); }
  catch {
    const id = crypto.randomUUID();
    fs.mkdirSync(path.dirname(idPath), { recursive: true });
    fs.writeFileSync(idPath, id);
    return id;
  }
}
function collect() {
  const nets = os.networkInterfaces();
  let ip = "", mac = "", adapter = "";
  for (const [name, items] of Object.entries(nets)) {
    for (const n of items || []) {
      if (!n.internal && n.family === "IPv4") {
        ip = n.address; mac = n.mac || ""; adapter = name; break;
      }
    }
    if (ip) break;
  }
  const c = getConfig();
  return {
    agentId: getAgentId(), ip, mac, adapter,
    hostname: os.hostname(), username: os.userInfo().username,
    firstName: c.firstName, lastName: c.lastName, personnelId: c.personnelId,
    os: process.platform, osVersion: os.release(),
    cpu: os.cpus()[0]?.model || "", ramMb: Math.round(os.totalmem() / 1024 / 1024),
    gateway: "", dns: "", agentVersion: c.agentVersion
  };
}
function ipv4ToInt(ip){return ip.split(".").reduce((n,o)=>(n<<8)+Number(o),0)>>>0}
function intToIpv4(n){return [(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255].join(".")}
function subnetRange(ip,mask){const i=ipv4ToInt(ip),m=ipv4ToInt(mask),network=(i&m)>>>0,broadcast=(network|(~m>>>0))>>>0;return{network,broadcast}}
function pingHost(ip){return new Promise(resolve=>{const win=process.platform==="win32";const args=win?["-n","1","-w","450",ip]:["-c","1","-W","1",ip];const started=Date.now();execFile("ping",args,{windowsHide:true,timeout:1500},async error=>{if(error)return resolve({ip,hostname:"",latencyMs:null,reachable:false});let hostname="";try{const names=await dns.reverse(ip);hostname=names[0]||""}catch{}resolve({ip,hostname,latencyMs:Date.now()-started,reachable:true})})})}
async function scanNetwork(){if(runtime.scanning)return networkHosts;runtime.scanning=true;runtime.scanError="";publish();try{const nets=os.networkInterfaces();let target=null;for(const items of Object.values(nets)){for(const n of items||[]){if(!n.internal&&n.family==="IPv4"&&n.address&&n.netmask){target=n;break}}if(target)break}if(!target)throw new Error("رابط IPv4 فعال پیدا نشد");const {network,broadcast}=subnetRange(target.address,target.netmask);const total=broadcast-network-1;if(total<1)throw new Error("محدوده شبکه معتبر نیست");if(total>1024)throw new Error("شبکه بزرگ‌تر از 1024 میزبان است؛ برای جلوگیری از فشار، اسکن متوقف شد.");const ips=[];for(let n=network+1;n<broadcast;n++)ips.push(intToIpv4(n));const results=[];for(let i=0;i<ips.length;i+=32){const batch=await Promise.all(ips.slice(i,i+32).map(pingHost));results.push(...batch)}networkHosts=results.filter(x=>x.reachable);runtime.lastScan=new Date().toISOString()}catch(e){runtime.scanError=e?.message||"خطای اسکن"}finally{runtime.scanning=false;publish()}return networkHosts}
function publish() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("agent-state", getState());
}
function getState() {
  return { config: getConfig(), data: collect(), runtime: { ...runtime }, networkHosts };
}
async function heartbeat() {
  const c = getConfig();
  const started = Date.now();
  runtime.lastAttempt = new Date().toISOString();
  runtime.lastError = "";
  publish();
  try {
    const response = await fetch(c.serverUrl.replace(/\/$/, "") + "/api/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json", ...(getKey() ? { "x-agent-key": getKey() } : {}) },
      body: JSON.stringify({ ...collect(), latencyMs: runtime.lastLatencyMs, networkHosts })
    });
    const roundTrip = Date.now() - started;
    runtime.lastLatencyMs = roundTrip;
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error("HTTP " + response.status + (body ? " - " + body : ""));
    }
    const data = await response.json();
    if (data.agentKey) saveKey(data.agentKey);
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
  const seconds = Math.max(10, Number(getConfig().heartbeatSeconds) || 30);
  runtime.nextHeartbeat = new Date(Date.now() + seconds * 1000).toISOString();
  heartbeatTimer = setTimeout(heartbeat, seconds * 1000);
}
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 620, height: 760, minWidth: 560, minHeight: 650,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, "ui.html"));
  mainWindow.on("closed", () => { mainWindow = null; });
}
app.whenReady().then(() => { createWindow(); heartbeat(); });
ipcMain.handle("get-state", () => getState());
ipcMain.handle("save-config", (_, incoming) => {
  const current = getConfig();
  const next = {
    ...current,
    serverUrl: String(incoming.serverUrl || current.serverUrl).trim().replace(/\/$/, ""),
    firstName: String(incoming.firstName || "").trim(),
    lastName: String(incoming.lastName || "").trim(),
    personnelId: String(incoming.personnelId || "").trim(),
    heartbeatSeconds: Math.max(10, Number(incoming.heartbeatSeconds) || 30)
  };
  saveConfig(next);
  scheduleHeartbeat();
  heartbeat();
  return getState();
});
ipcMain.on("heartbeat-now", () => heartbeat());
ipcMain.handle("scan-network", () => scanNetwork());
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
