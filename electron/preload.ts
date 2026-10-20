import { contextBridge, ipcRenderer } from "electron";
import type { HostApi } from "../shared/types";

function listen<T>(channel: string, cb: (e: T) => void) {
  const fn = (_: unknown, e: T) => cb(e);
  ipcRenderer.on(channel, fn);
  return () => void ipcRenderer.removeListener(channel, fn);
}

const api: HostApi = {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (patch) => ipcRenderer.invoke("settings:set", patch),
  chooseVault: () => ipcRenderer.invoke("vault:choose"),
  openVault: (dir) => ipcRenderer.invoke("vault:open", dir),
  createVault: (dir) => ipcRenderer.invoke("vault:create", dir),
  write: (p, c) => ipcRenderer.invoke("vault:write", p, c),
  rename: (a, b) => ipcRenderer.invoke("vault:rename", a, b),
  remove: (p) => ipcRenderer.invoke("vault:remove", p),
  readRaw: (p) => ipcRenderer.invoke("vault:readRaw", p),
  findByName: (name) => ipcRenderer.invoke("vault:findByName", name),
  onVaultEvent: (cb) => listen("vault:event", cb),
  ask: (id, q, s) => ipcRenderer.invoke("ai:ask", id, q, s),
  onAskEvent: (cb) => listen("ai:ask:event", cb),
  organize: (req) => ipcRenderer.invoke("ai:organize", req),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
};

contextBridge.exposeInMainWorld("railnote", api);
