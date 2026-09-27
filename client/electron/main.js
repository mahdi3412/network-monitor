const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");

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
let runtime = {
  connected: false,
  lastAttempt: null,
  lastSuccess: null,
  lastError: "",
  lastLatencyMs: null,
  nextHeartbeat: null
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
function publish() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("agent-state", getState());
}
function getState() {
  return { config: getConfig(), data: collect(), runtime: { ...runtime } };
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
      body: JSON.stringify({ ...collect(), latencyMs: runtime.lastLatencyMs })
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
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
