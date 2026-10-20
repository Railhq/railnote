import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import fs from "fs/promises";
import path from "path";
import type { OrganizeRequest, Settings, AskSource } from "../shared/types";
import { Vault, createStarterVault } from "./vault";
import { DEFAULT_MODEL, ask, describeError, organize } from "./ai";

if (process.env.RAILNOTE_USER_DATA) app.setPath("userData", process.env.RAILNOTE_USER_DATA);

const DEFAULTS: Settings = {
  recentVaults: [],
  model: DEFAULT_MODEL,
  dailyFolder: "Daily",
  inboxFolder: "Inbox",
  templatesFolder: "Templates",
};

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
let settings: Settings = { ...DEFAULTS };
let vault: Vault | undefined;
let win: BrowserWindow | undefined;

async function loadSettings() {
  try {
    settings = { ...DEFAULTS, ...JSON.parse(await fs.readFile(settingsFile(), "utf8")) };
  } catch {
    settings = { ...DEFAULTS };
  }
}

async function saveSettings() {
  await fs.mkdir(path.dirname(settingsFile()), { recursive: true });
  await fs.writeFile(settingsFile(), JSON.stringify(settings, null, 2), { mode: 0o600 });
}

/** The renderer never sees the API key; it only learns whether one is set. */
const publicSettings = (): Settings => ({ ...settings, anthropicApiKey: settings.anthropicApiKey ? "set" : undefined });

async function open(dir: string) {
  await vault?.close();
  vault = new Vault(path.resolve(dir));
  const files = await vault.readAll();
  vault.watch((e) => win?.webContents.send("vault:event", e));
  settings.vaultPath = vault.root;
  settings.recentVaults = [vault.root, ...settings.recentVaults.filter((v) => v !== vault!.root)].slice(0, 8);
  await saveSettings();
  return files;
}

function need(): Vault {
  if (!vault) throw new Error("No vault open");
  return vault;
}

function registerIpc() {
  ipcMain.handle("settings:get", () => publicSettings());
  ipcMain.handle("settings:set", async (_e, patch: Partial<Settings>) => {
    const { anthropicApiKey, ...rest } = patch;
    settings = { ...settings, ...rest };
    if (anthropicApiKey !== undefined) settings.anthropicApiKey = anthropicApiKey || undefined;
    await saveSettings();
    return publicSettings();
  });
  ipcMain.handle("vault:choose", async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle("vault:open", (_e, dir: string) => open(dir));
  ipcMain.handle("vault:create", async (_e, dir: string) => {
    const target = dir || path.join(app.getPath("documents"), "Railnote");
    await fs.mkdir(target, { recursive: true });
    await createStarterVault(target);
    return open(target);
  });
  ipcMain.handle("vault:write", (_e, p: string, c: string) => need().write(p, c));
  ipcMain.handle("vault:rename", (_e, a: string, b: string) => need().rename(a, b));
  ipcMain.handle("vault:remove", (_e, p: string) => need().remove(p));
  ipcMain.handle("vault:readRaw", (_e, p: string) => need().readRaw(p));
  ipcMain.handle("vault:findByName", (_e, name: string) => need().findByName(name));
  ipcMain.handle("ai:ask", (e, id: string, question: string, sources: AskSource[]) => {
    const send = (msg: object) => e.sender.send("ai:ask:event", { id, ...msg });
    // Resolve the invoke right away; the answer streams back as events.
    ask(settings.anthropicApiKey, settings.model, question, sources, (delta) => send({ delta }))
      .then(() => send({ done: true }))
      .catch((err) => send({ error: describeError(err), done: true }));
  });
  ipcMain.handle("ai:organize", async (_e, req: OrganizeRequest) => {
    try {
      return await organize(settings.anthropicApiKey, settings.model, req);
    } catch (err) {
      throw new Error(describeError(err));
    }
  });
  ipcMain.handle("shell:openExternal", (_e, url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#1e1e1e",
    show: !process.env.RAILNOTE_HEADLESS,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env.RAILNOTE_DEV) win.loadURL("http://localhost:5199");
  else win.loadFile(path.join(__dirname, "../dist/index.html"));
}

app.whenReady().then(async () => {
  await loadSettings();
  if (process.env.RAILNOTE_VAULT) settings.vaultPath = path.resolve(process.env.RAILNOTE_VAULT);
  registerIpc();
  createWindow();
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
