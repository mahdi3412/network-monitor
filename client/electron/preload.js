const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("agent", {
  getState: () => ipcRenderer.invoke("get-state"),
  saveConfig: (config) => ipcRenderer.invoke("save-config", config),
  heartbeatNow: () => ipcRenderer.send("heartbeat-now"),
  scanNetwork: () => ipcRenderer.invoke("scan-network"),
  onState: (callback) => {
    const handler = (_, state) => callback(state);
    ipcRenderer.on("agent-state", handler);
    return () => ipcRenderer.removeListener("agent-state", handler);
  }
});
