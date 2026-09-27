const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const { execFile } = require("child_process");
const dns = require("dns").promises;
const net = require("net");

const configPath = path.join(app.getPath("userData"), "config.json");
const keyPath = path.join(app.getPath("userData"), "agent-key");
const idPath = path.join(app.getPath("userData"), "agent-id");
const defaults = {
  serverUrl: "http://localhost:3000",
  firstName: "",
  lastName: "",
  personnelId: "",
  heartbeatSeconds: 30,
  agentVersion: "1.1.0",
  scanRanges: ""
};

let mainWindow = null;
let heartbeatTimer = null;
let networkScanTimer = null;
let networkHosts = [];
let networkInfo = { gateway: "", dns: "" };
let runtime = {
  connected: false,
  lastAttempt: null,
  lastSuccess: null,
  lastError: "",
  lastLatencyMs: null,
  nextHeartbeat: null,
  scanning: false,
  lastScan: null,
  scanError: "",
  scanTotal: 0,
  scanCompleted: 0,
  scanRange: ""
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
    gateway: networkInfo.gateway, dns: networkInfo.dns || getDnsServers(), agentVersion: c.agentVersion
  };
}
function ipv4ToInt(ip){return ip.split(".").reduce((n,o)=>(n<<8)+Number(o),0)>>>0}
function intToIpv4(n){return [(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255].join(".")}
function subnetRange(ip,mask){const i=ipv4ToInt(ip),m=ipv4ToInt(mask),network=(i&m)>>>0,broadcast=(network|(~m>>>0))>>>0;return{network,broadcast}}
function pingHost(ip){return new Promise(resolve=>{const win=process.platform==="win32";const args=win?["-n","1","-w","500",ip]:["-c","1","-W","1",ip];const started=Date.now();execFile("ping",args,{windowsHide:true,timeout:1700},async error=>{if(error)return resolve({ip,hostname:"",latencyMs:null,reachable:false,method:"icmp"});let hostname="";try{const names=await dns.reverse(ip);hostname=names[0]||""}catch{}resolve({ip,hostname,latencyMs:Date.now()-started,reachable:true,method:"icmp"})})})}
function getRouteRanges() {
  return new Promise(resolve => {
    if (process.platform !== "win32") return resolve([]);
    execFile("route", ["print", "-4"], { windowsHide: true, timeout: 3000 }, (error, stdout) => {
      if (error) return resolve([]);
      const rows = [];
      for (const line of String(stdout || "").split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+\d+$/);
        if (!m || m[1] === "0.0.0.0") continue;
        const maskInt = ipv4ToInt(m[2]);
        const network = (ipv4ToInt(m[1]) & maskInt) >>> 0;
        const broadcast = (network | (~maskInt >>> 0)) >>> 0;
        const total = broadcast - network - 1;
        if (total >= 1 && total <= 8192) rows.push({ network, broadcast, subnet: intToIpv4(network)+"/"+m[2], adapter:"routed" });
      }
      resolve(rows);
    });
  });
}
function tcpProbe(ip, port, timeout = 700) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    const started = Date.now();
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => finish(Math.max(1, Date.now() - started)));
    socket.once("timeout", () => finish(null));
    socket.once("error", () => finish(null));
    try { socket.connect(port, ip); } catch { finish(null); }
  });
}
async function probeServices(ip) {
  const ports = [22,80,443,445,515,631,3389,9100];
  const found = {};
  for (let i=0;i<ports.length;i+=4) {
    const batch = await Promise.all(ports.slice(i,i+4).map(async p => [p, await tcpProbe(ip,p)]));
    for (const [port, latency] of batch) if (latency != null) found[port]=latency;
  }
  return found;
}
function classifyHost(host, servicePorts) {
  const name = String(host.hostname || "").toLowerCase();
  if (host.ip === networkInfo.gateway) return "gateway";
  if (servicePorts.includes(9100) || servicePorts.includes(631) || servicePorts.includes(515) || /printer|print|پرینتر|پرینت/.test(name)) return "printer";
  if (/switch|router|gateway|firewall|mikrotik|cisco|ubiquiti|aruba|forti|core|ap|access.?point/.test(name) && (servicePorts.includes(22) || servicePorts.includes(80) || servicePorts.includes(443))) return "network-device";
  if (servicePorts.includes(445) || servicePorts.includes(3389) || /pc-|desktop|win|server|laptop|workstation/.test(name)) return "windows";
  if (servicePorts.includes(22)) return "linux-or-network";
  return "unknown";
}
function enrichHost(host) {
  return new Promise(async resolve => {
    try {
      const services = await probeServices(host.ip);
      const servicePorts = Object.keys(services).map(Number);
      host.services = servicePorts.map(p => ({
        22:"SSH",80:"HTTP",443:"HTTPS",445:"SMB",515:"LPD",631:"IPP",3389:"RDP",9100:"RAW-PRINT"
      }[p] || String(p)));
      host.servicePorts = servicePorts;
      host.deviceType = classifyHost(host, servicePorts);
    } catch {
      host.services = [];
      host.servicePorts = [];
      host.deviceType = classifyHost(host, []);
    }
    resolve(host);
  });
}
function configuredRanges() {
  const raw=String(getConfig().scanRanges||"");
  return raw.split(/[\s,;]+/).map(x=>x.trim()).filter(Boolean).map(cidr=>{
    const parts=cidr.split("/");
    if(parts.length!==2||!/^\d+$/.test(parts[1])) return null;
    const prefix=Math.max(0,Math.min(32,Number(parts[1])));
    const mask=prefix===0?0:(0xffffffff << (32-prefix))>>>0;
    const ipInt=ipv4ToInt(parts[0]);
    const network=(ipInt&mask)>>>0;
    const broadcast=(network|(~mask>>>0))>>>0;
    const total=broadcast-network-1;
    if(total<1||total>8192) return null;
    return {network,broadcast,subnet:intToIpv4(network)+"/"+prefix,adapter:"configured"};
  }).filter(Boolean);
}
async function scanNetwork(){
  if(runtime.scanning)return networkHosts;
  runtime.scanning=true;runtime.scanError="";runtime.scanCompleted=0;runtime.scanTotal=0;runtime.scanRange="";publish();
  try{
    const interfaces=getNetworkInterfaces();
    if(!interfaces.length)throw new Error("رابط IPv4 فعال پیدا نشد");
    const arp=await getArpTable();
    const byIp=new Map(arp.map(x=>[x.ip,x]));
    const ranges=[];
    for(const n of interfaces){const r=subnetRange(n.address,n.netmask);if(r.broadcast-r.network-1>=1&&r.broadcast-r.network-1<=8192)ranges.push({...r,subnet:n.address+"/"+n.netmask,adapter:n.name});}
    ranges.push(...await getRouteRanges(),...configuredRanges());
    const unique=new Map(ranges.map(r=>[r.subnet,r]));
    runtime.scanTotal=[...unique.values()].reduce((sum,r)=>sum+Math.max(0,r.broadcast-r.network-1),0);publish();
    const results=new Map();
    for(const target of unique.values()){
      runtime.scanRange=target.subnet;publish();
      const ips=[];for(let n=target.network+1;n<target.broadcast;n++)ips.push(intToIpv4(n));
      for(let i=0;i<ips.length;i+=48){
        const batch=await Promise.all(ips.slice(i,i+48).map(pingHost));
        for(const r of batch)if(r.reachable){const a=byIp.get(r.ip);results.set(r.ip,{...r,mac:a?.mac||"",adapter:target.adapter,subnet:target.subnet});}
        runtime.scanCompleted=Math.min(runtime.scanTotal,runtime.scanCompleted+batch.length);publish();
      }
    }
    for(const a of arp){
      if(!results.has(a.ip)){
        const target=[...unique.values()].find(x=>{const n=ipv4ToInt(a.ip);return n>x.network&&n<x.broadcast;});
        if(target)results.set(a.ip,{ip:a.ip,hostname:"",mac:a.mac,latencyMs:null,reachable:true,method:"arp",adapter:target.adapter,subnet:target.subnet});
      }else if(a.mac)results.get(a.ip).mac=a.mac;
    }
    const candidates=[...results.values()];
    for(let i=0;i<candidates.length;i+=12){
      await Promise.all(candidates.slice(i,i+12).map(async r=>{
        if(!r.hostname){
          try{const names=await dns.reverse(r.ip);r.hostname=names[0]||""}catch{}
        }
        if(process.platform==="win32"&&!r.hostname){
          try{
            const out=await new Promise(resolve=>execFile("nbtstat",["-A",r.ip],{windowsHide:true,timeout:1800},(_,stdout)=>resolve(String(stdout||""))));
            const m=String(out).match(/(?:^|\s)([A-Za-z0-9._-]+)\s+<00>\s+UNIQUE/i);
            if(m)r.hostname=m[1];
          }catch{}
        }
        const enriched=await enrichHost(r);
        Object.assign(r,enriched);
      }));
      publish();
    }
    networkHosts=candidates.sort((a,b)=>ipv4ToInt(a.ip)-ipv4ToInt(b.ip));
    runtime.lastScan=new Date().toISOString();runtime.scanRange="";
  }catch(e){runtime.scanError=e?.message||"خطای اسکن"}
  finally{runtime.scanning=false;publish()}
  return networkHosts
}
async function refreshNetworkInfo() {
  networkInfo.dns = getDnsServers();
  networkInfo.gateway = await getGateway();
  publish();
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
function scheduleNetworkScan() {
  if (networkScanTimer) clearTimeout(networkScanTimer);
  networkScanTimer = setTimeout(async () => { await scanNetwork(); scheduleNetworkScan(); }, 5 * 60 * 1000);
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
app.whenReady().then(async () => { createWindow(); await refreshNetworkInfo(); scheduleNetworkScan(); scanNetwork().catch(()=>{}); heartbeat(); });
ipcMain.handle("get-state", () => getState());
ipcMain.handle("save-config", (_, incoming) => {
  const current = getConfig();
  const next = {
    ...current,
    serverUrl: String(incoming.serverUrl || current.serverUrl).trim().replace(/\/$/, ""),
    firstName: String(incoming.firstName || "").trim(),
    lastName: String(incoming.lastName || "").trim(),
    personnelId: String(incoming.personnelId || "").trim(),
    scanRanges: String(incoming.scanRanges || current.scanRanges || "").trim(),
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
