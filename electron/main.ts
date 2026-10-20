import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from "electron";
import { pathToFileURL } from "url";
import fs from "fs/promises";
import path from "path";
import type { OrganizeRequest, PluginManifest, Settings, AskSource } from "../shared/types";
import { Vault, createStarterVault } from "./vault";
import { DEFAULT_MODEL, ask, describeError, organize } from "./ai";

if (process.env.RAILNOTE_USER_DATA) app.setPath("userData", process.env.RAILNOTE_USER_DATA);

// Vault plugins load as ES modules from railnote-plugin://<id>/<file>, served out of the open vault.
const PLUGIN_SCHEME = "railnote-plugin";
protocol.registerSchemesAsPrivileged([{ scheme: PLUGIN_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

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

const pluginsDir = () => path.join(need().root, ".railnote", "plugins");

async function listVaultPlugins(): Promise<PluginManifest[]> {
  if (!vault) return [];
  let dirs: string[];
  try {
    dirs = (await fs.readdir(pluginsDir(), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out: PluginManifest[] = [];
  for (const dir of dirs.sort()) {
    const base: PluginManifest = { id: dir, name: dir, version: "" };
    try {
      const m = JSON.parse(await fs.readFile(path.join(pluginsDir(), dir, "manifest.json"), "utf8"));
      if (m.id !== dir) throw new Error(`manifest id "${m.id}" must match its folder name "${dir}"`);
      if (!PLUGIN_ID.test(dir)) throw new Error("id may only use lowercase letters, digits and dashes");
      const main = typeof m.main === "string" ? m.main : "main.js";
      const stat = await fs.stat(path.join(pluginsDir(), dir, main));
      out.push({
        id: dir,
        name: String(m.name || dir),
        version: String(m.version || ""),
        description: m.description ? String(m.description) : undefined,
        author: m.author ? String(m.author) : undefined,
        main,
        // The mtime busts the module cache so a reload picks up edits.
        url: `${PLUGIN_SCHEME}://${dir}/${main.split("/").map(encodeURIComponent).join("/")}?v=${stat.mtimeMs}`,
      });
    } catch (e) {
      out.push({ ...base, error: (e as Error).message });
    }
  }
  return out;
}

/** Only files inside a plugin's own folder, and only for vaults the user trusts. */
function servePlugins() {
  protocol.handle(PLUGIN_SCHEME, async (req) => {
    const url = new URL(req.url);
    const id = url.hostname;
    if (!vault || !PLUGIN_ID.test(id) || !settings.trustedVaults?.includes(vault.root)) return new Response("Not allowed", { status: 403 });
    const dir = path.join(pluginsDir(), id);
    const file = path.resolve(dir, "." + decodeURIComponent(url.pathname));
    if (!file.startsWith(dir + path.sep)) return new Response("Not allowed", { status: 403 });
    const res = await net.fetch(pathToFileURL(file).toString()).catch(() => new Response("Not found", { status: 404 }));
    if (!res.ok || !/\.m?js$/.test(file)) return res;
    // The app page is file://, a different origin, so module loads need CORS.
    return new Response(res.body, { headers: { "content-type": "text/javascript", "access-control-allow-origin": "*" } });
  });
}

function registerIpc() {
  ipcMain.handle("plugins:list", () => listVaultPlugins());
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
  servePlugins();
  createWindow();
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
