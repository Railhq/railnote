import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell, type MenuItemConstructorOptions } from "electron";
import { pathToFileURL } from "url";
import { createReadStream } from "fs";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { Readable } from "stream";
import type { AgentId, OrganizeRequest, PluginManifest, Settings, AskSource, SyncSetup, SyncStatus } from "../shared/types";
import type { SyncConfig } from "../shared/sync";
import { IGNORED, Vault, createStarterVault, installAgentSkills } from "./vault";
import { DEFAULT_MODEL, ask, describeError, organize } from "./ai";
import { askAgent, defaultAgent, listAgents, organizeWithAgent } from "./agents";
import { gitInfo, gitSyncVault, setUpGitHub, setUpSync, syncVault } from "./sync";
import { updateElectronApp } from "update-electron-app";
import squirrelStartup from "electron-squirrel-startup";

// The Windows installer starts the app to add its shortcuts (and the uninstaller to remove them);
// those runs do that and quit.
if (squirrelStartup) app.quit();

if (process.env.RAILNOTE_USER_DATA) app.setPath("userData", process.env.RAILNOTE_USER_DATA);

// Vault plugins load as ES modules from railnote-plugin://<id>/<file>, served out of the open vault.
const PLUGIN_SCHEME = "railnote-plugin";
// Attachments (images, audio, video, PDFs) load from railnote-file://vault/<path>.
const FILE_SCHEME = "railnote-file";
protocol.registerSchemesAsPrivileged([
  { scheme: PLUGIN_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: FILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg", flac: "audio/flac", webm: "video/webm", mp4: "video/mp4", mov: "video/quicktime",
  pdf: "application/pdf", json: "application/json", txt: "text/plain", canviz: "application/json",
};
const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

const DEFAULTS: Settings = {
  recentVaults: [],
  model: DEFAULT_MODEL,
  dailyFolder: "Daily",
  inboxFolder: "Inbox",
  templatesFolder: "Templates",
};

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
/** Settings plus what only the main process may read: each vault's sync passphrase, or the repository it syncs through. */
let settings: Settings & { sync?: Record<string, SyncConfig>; git?: Record<string, { remote: string }> } = { ...DEFAULTS };
const SKILLS = path.join(__dirname, "skills");
/** The app icon (build/icon.svg). A packaged app takes build/icon.icns from its bundle instead. */
const ICON = path.join(__dirname, "..", "build", "icon.png");
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
const publicSettings = (): Settings => {
  const { sync: _, git: __, ...rest } = settings;
  return { ...rest, anthropicApiKey: settings.anthropicApiKey ? "set" : undefined };
};

let sync: ReturnType<typeof syncVault | typeof gitSyncVault> | undefined;
const OFF: SyncStatus = { on: false };

function startSync() {
  sync?.stop();
  sync = undefined;
  if (!vault) return;
  const emit = (status: SyncStatus, conflicts?: string[]) => win?.webContents.send("sync:event", { status, conflicts });
  const repo = settings.git?.[vault.root];
  const cfg = settings.sync?.[vault.root];
  if (repo) sync = gitSyncVault(vault, repo.remote, emit);
  else if (cfg) sync = syncVault(vault, cfg, emit);
  else return;
  sync.start();
}

async function open(dir: string) {
  await vault?.close();
  vault = new Vault(path.resolve(dir));
  const files = await vault.readAll();
  vault.watch((e) => {
    win?.webContents.send("vault:event", e);
    sync?.poke();
  });
  startSync();
  settings.vaultPath = vault.root;
  settings.recentVaults = [vault.root, ...settings.recentVaults.filter((v) => v !== vault!.root)].slice(0, 8);
  await saveSettings();
  return files;
}

/** The agent that answers Ask and Organize, or null for Claude through the API key. */
async function chosenAgent(): Promise<AgentId | null> {
  if (settings.ai === "api") return null;
  return settings.ai ?? (await defaultAgent());
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

/** Serves vault files to the page, with byte ranges so audio and video can seek. Hidden folders stay private. */
function serveFiles() {
  protocol.handle(FILE_SCHEME, async (req) => {
    if (!vault) return new Response("No vault open", { status: 404 });
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, "");
    let abs: string;
    try {
      abs = vault.resolve(rel);
    } catch {
      return new Response("Not allowed", { status: 403 });
    }
    if (IGNORED.test(rel) || rel.split("/").some((p) => p.startsWith("."))) return new Response("Not allowed", { status: 403 });
    let size: number;
    try {
      const st = await fs.stat(abs);
      if (!st.isFile()) throw new Error();
      size = st.size;
    } catch {
      return new Response("Not found", { status: 404 });
    }
    const type = MIME[path.extname(abs).slice(1).toLowerCase()] ?? "application/octet-stream";
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
    const headers: Record<string, string> = { "content-type": type, "accept-ranges": "bytes", "access-control-allow-origin": "*" };
    if (range && size > 0) {
      const start = range[1] ? Number(range[1]) : Math.max(size - Number(range[2]), 0);
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
      const body = Readable.toWeb(createReadStream(abs, { start, end })) as ReadableStream;
      return new Response(body, { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) } });
    }
    return new Response(Readable.toWeb(createReadStream(abs)) as ReadableStream, { headers: { ...headers, "content-length": String(size) } });
  });
}

/** Prints an exported page to PDF in a hidden window, after its explainers have drawn a frame. */
async function htmlToPdf(html: string): Promise<Buffer> {
  const tmp = path.join(os.tmpdir(), `railnote-export-${Date.now()}.html`);
  await fs.writeFile(tmp, html, "utf8");
  const w = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await w.loadFile(tmp);
    for (let i = 0; i < 100; i++) {
      if (await w.webContents.executeJavaScript("window.__railnoteReady === true").catch(() => true)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return await w.webContents.printToPDF({ printBackground: true, pageSize: "A4" });
  } finally {
    w.destroy();
    fs.unlink(tmp).catch(() => {});
  }
}

function registerIpc() {
  ipcMain.handle("plugins:list", () => listVaultPlugins());
  ipcMain.handle("settings:get", () => publicSettings());
  ipcMain.handle("settings:set", async (_e, patch: Partial<Settings>) => {
    const { anthropicApiKey, sync: _, ...rest } = patch as typeof settings;
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
  ipcMain.handle("sync:status", () => sync?.status ?? OFF);
  ipcMain.handle("sync:on", async (_e, setup: SyncSetup) => {
    const root = need().root;
    const cfg = await setUpSync(setup);
    settings.sync = { ...settings.sync, [root]: cfg };
    await saveSettings();
    startSync();
    return sync!.status;
  });
  ipcMain.handle("sync:git:info", () => gitInfo(need().root));
  ipcMain.handle("sync:git:on", async (_e, given: string) => {
    const root = need().root;
    const remote = await setUpGitHub(root, given);
    settings.git = { ...settings.git, [root]: { remote } };
    await saveSettings();
    startSync();
    return sync!.now();
  });
  ipcMain.handle("sync:off", async () => {
    const root = need().root;
    const { [root]: _, ...rest } = settings.sync ?? {};
    settings.sync = rest;
    const { [root]: __, ...repos } = settings.git ?? {};
    settings.git = repos;
    await saveSettings();
    startSync();
    await fs.rm(path.join(root, ".railnote", "sync.json"), { force: true });
    return OFF;
  });
  ipcMain.handle("sync:now", () => sync?.now() ?? OFF);
  ipcMain.handle("vault:create", async (_e, dir: string) => {
    const target = dir || path.join(app.getPath("documents"), "Railnote");
    await fs.mkdir(target, { recursive: true });
    await createStarterVault(target);
    await installAgentSkills(target, SKILLS, false);
    return open(target);
  });
  // Updates a vault's copy of the agent skills to the ones this version of the app ships.
  ipcMain.handle("vault:installSkills", () => installAgentSkills(need().root, SKILLS, true));
  ipcMain.handle("vault:write", (_e, p: string, c: string) => need().write(p, c).then(() => sync?.poke()));
  ipcMain.handle("vault:rename", (_e, a: string, b: string) => need().rename(a, b).then(() => sync?.poke()));
  ipcMain.handle("vault:remove", (_e, p: string) => need().remove(p).then(() => sync?.poke()));
  ipcMain.handle("history:list", (_e, p: string) => need().history.list(p));
  ipcMain.handle("history:read", (_e, p: string, id: string) => need().history.read(p, id));
  ipcMain.handle("history:restore", (_e, p: string, id: string) => need().restore(p, id).then((t) => (sync?.poke(), t)));
  ipcMain.handle("vault:readRaw", (_e, p: string) => need().readRaw(p));
  ipcMain.handle("vault:findByName", (_e, name: string) => need().findByName(name));
  ipcMain.handle("vault:readBase64", async (_e, p: string) => (await fs.readFile(need().resolve(p))).toString("base64"));
  ipcMain.handle("vault:list", () => need().list());
  ipcMain.handle("vault:saveAttachment", (_e, folder: string, name: string, bytes: Uint8Array) => need().saveAttachment(folder, name, bytes));
  ipcMain.handle("vault:mkdir", (_e, p: string) => need().mkdir(p));
  ipcMain.handle("vault:openInSystem", async (_e, p: string) => {
    const err = await shell.openPath(need().resolve(p));
    if (err) throw new Error(err);
  });
  ipcMain.handle("vault:reveal", (_e, p: string) => shell.showItemInFolder(need().resolve(p)));
  ipcMain.handle("export:asset", async (_e, name: string) => {
    for (const dir of [path.join(__dirname, "..", "dist-export"), path.join(__dirname, "export-fonts")]) {
      const b = await fs.readFile(path.join(dir, path.basename(name))).catch(() => null);
      if (b) return b.toString("base64");
    }
    return null;
  });
  ipcMain.handle("export:save", async (_e, name: string, kind: "html" | "pdf", html: string) => {
    // Tests set RAILNOTE_EXPORT_DIR to skip the dialog.
    const target = process.env.RAILNOTE_EXPORT_DIR
      ? path.join(process.env.RAILNOTE_EXPORT_DIR, `${name}.${kind}`)
      : (await dialog.showSaveDialog(win!, { defaultPath: path.join(app.getPath("documents"), `${name}.${kind}`), filters: [{ name: kind.toUpperCase(), extensions: [kind] }] })).filePath;
    if (!target) return false;
    await fs.writeFile(target, kind === "pdf" ? await htmlToPdf(html) : html);
    return true;
  });
  ipcMain.handle("ai:agents", () => listAgents());
  ipcMain.handle("ai:ask", async (e, id: string, question: string, sources: AskSource[]) => {
    const send = (msg: object) => e.sender.send("ai:ask:event", { id, ...msg });
    const agent = await chosenAgent();
    const onDelta = (delta: string) => send({ delta });
    // Resolve the invoke right away; the answer streams back as events.
    (agent ? askAgent(agent, need().root, question, sources.map((s) => s.path), !!settings.agentEdits, settings.agentModel || undefined, onDelta) : ask(settings.anthropicApiKey, settings.model, question, sources, onDelta))
      .then(() => send({ done: true }))
      .catch((err) => send({ error: describeError(err), done: true }));
  });
  ipcMain.handle("ai:organize", async (_e, req: OrganizeRequest) => {
    const agent = await chosenAgent();
    try {
      return agent ? await organizeWithAgent(agent, need().root, req, settings.agentModel || undefined) : await organize(settings.anthropicApiKey, settings.model, req);
    } catch (err) {
      throw new Error(describeError(err));
    }
  });
  ipcMain.handle("shell:openExternal", (_e, url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url);
  });
}

/** The standard menus, except Cmd+W closes the note tab instead of the window. */
function buildMenu() {
  const send = (cmd: string) => () => win?.webContents.send("menu:command", cmd);
  const mac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        { label: "Open Vault…", accelerator: "CmdOrCtrl+Alt+O", click: send("open-vault") },
        { type: "separator" },
        { label: "Version History…", accelerator: "CmdOrCtrl+Shift+H", click: send("history") },
        { type: "separator" },
        { label: "Export to HTML…", click: send("export-html") },
        { label: "Export to PDF…", accelerator: "CmdOrCtrl+Alt+P", click: send("export-pdf") },
        { type: "separator" },
        { label: "Close Tab", accelerator: "CmdOrCtrl+W", click: send("close-tab") },
        { label: "Close Window", accelerator: "CmdOrCtrl+Shift+W", role: "close" },
        ...(mac ? [] : [{ role: "quit" as const }]),
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    // Level with the tab line, whose stops are centred 15px down.
    trafficLightPosition: { x: 20, y: 8 },
    backgroundColor: "#1e1e1e",
    icon: ICON,
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
  // Coming back to the window is when you'd look for what you wrote on your phone.
  win.on("focus", () => sync?.poke());
  if (process.env.RAILNOTE_DEV) win.loadURL("http://localhost:5199");
  else win.loadFile(path.join(__dirname, "../dist/index.html"));
}

app.whenReady().then(async () => {
  if (process.platform === "darwin" && !app.isPackaged) app.dock?.setIcon(ICON);
  await loadSettings();
  if (process.env.RAILNOTE_VAULT) settings.vaultPath = path.resolve(process.env.RAILNOTE_VAULT);
  registerIpc();
  buildMenu();
  servePlugins();
  serveFiles();
  // Released builds check GitHub Releases (through update.electronjs.org) and offer to restart
  // into a new version. It needs a Developer ID signature; an ad hoc build just logs the failure.
  // Electron can't update itself on Linux, where a new AppImage or .deb is downloaded instead.
  if (app.isPackaged && process.platform !== "linux") updateElectronApp({ repo: "Railhq/railnote" });
  createWindow();
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

// Stop watching before quitting: fsevents can deadlock in its teardown at exit when watched
// folders were renamed or moved while the app ran.
let watcherClosed = false;
app.on("before-quit", (e) => {
  if (watcherClosed || !vault) return;
  e.preventDefault();
  watcherClosed = true;
  const done = () => app.quit();
  Promise.race([vault.close(), new Promise((r) => setTimeout(r, 2000))]).then(done, done);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
