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
function getNetworkInterfaces() {
  const nets = os.networkInterfaces();
  const result = [];
  for (const [name, items] of Object.entries(nets)) {
    for (const n of items || []) {
      if (!n.internal && n.family === "IPv4" && n.address && n.netmask) {
        result.push({ ...n, name });
      }
    }
  }
  return result;
}
function getGateway() {
  return new Promise(resolve => {
    if (process.platform !== "win32") return resolve("");
    execFile("route", ["print", "-4"], { windowsHide: true, timeout: 2000 }, (error, stdout) => {
      if (error) return resolve("");
      const lines = String(stdout || "").split(/\r?\n/);
      for (const line of lines) {
        const m = line.trim().match(/^0\.0\.0\.0\s+0\.0\.0\.0\s+(\S+)\s+/);
        if (m) return resolve(m[1]);
      }
      resolve("");
    });
  });
}
function getDnsServers() {
  try { return dns.getServers().join(", "); } catch { return ""; }
}
function collect() {
  const nets = getNetworkInterfaces();
  const primary = nets[0] || {};
  const c = getConfig();
  return {
    agentId: getAgentId(), ip: primary.address || "", mac: primary.mac || "", adapter: primary.name || "",
    hostname: os.hostname(), username: os.userInfo().username,
    firstName: c.firstName, lastName: c.lastName, personnelId: c.personnelId,
    os: process.platform, osVersion: os.release(),
    cpu: os.cpus()[0]?.model || "", ramMb: Math.round(os.totalmem() / 1024 / 1024),
    gateway: "", dns: getDnsServers(), agentVersion: c.agentVersion
  };
}
function ipv4ToInt(ip){return ip.split(".").reduce((n,o)=>(n<<8)+Number(o),0)>>>0}
function intToIpv4(n){return [(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255].join(".")}
function subnetRange(ip,mask){const i=ipv4ToInt(ip),m=ipv4ToInt(mask),network=(i&m)>>>0,broadcast=(network|(~m>>>0))>>>0;return{network,broadcast}}
function pingHost(ip){return new Promise(resolve=>{const win=process.platform==="win32";const args=win?["-n","1","-w","450",ip]:["-c","1","-W","1",ip];const started=Date.now();execFile("ping",args,{windowsHide:true,timeout:1500},async error=>{if(error)return resolve({ip,hostname:"",latencyMs:null,reachable:false,method:"icmp"});let hostname="";try{const names=await dns.reverse(ip);hostname=names[0]||""}catch{}resolve({ip,hostname,latencyMs:Date.now()-started,reachable:true,method:"icmp"})})})}
function getArpTable() {
  return new Promise(resolve => {
    if (process.platform !== "win32") return resolve([]);
    execFile("arp", ["-a"], { windowsHide: true, timeout: 3000 }, (error, stdout) => {
      if (error) return resolve([]);
      const rows = [];
      let iface = "";
      for (const line of String(stdout || "").split(/\r?\n/)) {
        const im = line.match(/Interface:\s+(\d+\.\d+\.\d+\.\d+)/i);
        if (im) { iface = im[1]; continue; }
        const m = line.trim().match(/^(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f-]{17})\s+(dynamic|static)$/i);
        if (m) rows.push({ ip:m[1], mac:m[2].replace(/-/g,":").toLowerCase(), interfaceIp:iface });
      }
      resolve(rows);
    });
  });
}
async function scanNetwork(){
  if(runtime.scanning)return networkHosts;
  runtime.scanning=true;runtime.scanError="";publish();
  try{
    const interfaces=getNetworkInterfaces();
    if(!interfaces.length)throw new Error("رابط IPv4 فعال پیدا نشد");
    const arp=await getArpTable();
    const byIp=new Map(arp.map(x=>[x.ip,x]));
    const results=new Map();
    for(const target of interfaces){
      const {network,broadcast}=subnetRange(target.address,target.netmask);
      const total=broadcast-network-1;
      if(total<1)continue;
      if(total>1024){continue;}
      const ips=[];for(let n=network+1;n<broadcast;n++)ips.push(intToIpv4(n));
      for(let i=0;i<ips.length;i+=32){
        const batch=await Promise.all(ips.slice(i,i+32).map(pingHost));
        for(const r of batch){
          if(r.reachable){
            const a=byIp.get(r.ip);
            results.set(r.ip,{...r,mac:a?.mac||"",adapter:target.name,subnet:target.address+"/"+target.netmask});
          }
        }
      }
    }
    for(const a of arp){
      if(!results.has(a.ip)){
        const target=interfaces.find(x=>{const r=subnetRange(x.address,x.netmask),n=ipv4ToInt(a.ip);return n>r.network&&n<r.broadcast;});
        if(target)results.set(a.ip,{ip:a.ip,hostname:"",mac:a.mac,latencyMs:null,reachable:true,method:"arp",adapter:target.name,subnet:target.address+"/"+target.netmask});
      }else if(a.mac)results.get(a.ip).mac=a.mac;
    }
    for(const r of results.values()){
      if(!r.hostname)try{const names=await dns.reverse(r.ip);r.hostname=names[0]||""}catch{}
    }
    networkHosts=[...results.values()].sort((a,b)=>ipv4ToInt(a.ip)-ipv4ToInt(b.ip));
    runtime.lastScan=new Date().toISOString();
  }catch(e){runtime.scanError=e?.message||"خطای اسکن"}
  finally{runtime.scanning=false;publish()}
  return networkHosts
}
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
