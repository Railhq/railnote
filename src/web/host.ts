/**
 * Railnote's host for the phone: the same app, with the vault kept in the browser's storage and
 * kept in step with the user's computers through their sync server. It stands in for the
 * Electron preload, so the app code doesn't know which one it's running on.
 */
import { DEFAULT_MODEL, ask, describeError, organize } from "../../electron/ai";
import { STARTER_FILES } from "../../shared/starter";
import { SyncLoop, setUpSync, sha256, type SyncConfig, type SyncState, type SyncStore } from "../../shared/sync";
import { isNotePath, type HostApi, type NoteFile, type Settings, type SyncStatus, type VaultEvent } from "../../shared/types";
import { files, keepStorage, kv, type StoredFile } from "./store";

const VAULT = "This phone";
const DEFAULTS: Settings = { recentVaults: [], model: DEFAULT_MODEL, dailyFolder: "Daily", inboxFolder: "Inbox", templatesFolder: "Templates" };
const utf8 = new TextEncoder();
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const hidden = (p: string) => p.split("/").some((part) => part.startsWith("."));

function listeners<T>() {
  const set = new Set<(e: T) => void>();
  return {
    on(cb: (e: T) => void) {
      set.add(cb);
      return () => void set.delete(cb);
    },
    emit: (e: T) => set.forEach((cb) => cb(e)),
  };
}

const vaultEvents = listeners<VaultEvent>();
const syncEvents = listeners<{ status: SyncStatus; conflicts?: string[] }>();
const askEvents = listeners<{ id: string; delta?: string; done?: boolean; error?: string }>();

type Private = Settings & { sync?: SyncConfig; opened?: boolean; folders?: string[] };
const load = async (): Promise<Private> => ({ ...DEFAULTS, ...(await kv.get<Private>("settings")) });
const save = (s: Private) => kv.set("settings", s);
const publicSettings = (s: Private): Settings => {
  const { sync: _, opened, folders: __, ...rest } = s;
  return { ...rest, vaultPath: opened ? VAULT : undefined, recentVaults: [], anthropicApiKey: s.anthropicApiKey ? "set" : undefined };
};

const toNote = (f: StoredFile): NoteFile => ({ path: f.path, content: text(f.bytes), mtime: f.mtime });

async function put(path: string, bytes: Uint8Array) {
  await files.put({ path, bytes, mtime: Date.now(), hash: await sha256(bytes) });
}

/** The phone's files as the sync engine sees them. Writes from other devices reach the open app. */
const store: SyncStore = {
  async list() {
    const out = new Map<string, string>();
    for (const f of await files.all()) if (!hidden(f.path)) out.set(f.path, f.hash);
    return out;
  },
  async read(path) {
    const f = await files.get(path);
    if (!f) throw new Error(`${path} is gone`);
    return f.bytes;
  },
  async write(path, bytes) {
    await put(path, bytes);
    if (isNotePath(path)) vaultEvents.emit({ type: "upsert", file: toNote((await files.get(path))!) });
    else vaultEvents.emit({ type: "file", path, exists: true });
  },
  async remove(path) {
    await files.delete(path);
    vaultEvents.emit(isNotePath(path) ? { type: "delete", path } : { type: "file", path, exists: false });
  },
  loadState: async () => (await kv.get<SyncState>("syncState")) ?? null,
  saveState: async (s) => void (await kv.set("syncState", s)),
};

let loop: SyncLoop | undefined;
const OFF: SyncStatus = { on: false };

async function startSync() {
  loop?.stop();
  loop = undefined;
  const cfg = (await load()).sync;
  if (!cfg) return;
  loop = new SyncLoop(store, cfg, (status, conflicts) => syncEvents.emit({ status, conflicts }));
  loop.start();
}

// A phone sleeps the page; sync again as soon as it's looked at or back online.
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && loop?.poke());
window.addEventListener("online", () => loop?.poke());

const changed = () => loop?.poke();

async function notes() {
  return (await files.all()).filter((f) => isNotePath(f.path) && !hidden(f.path)).map(toNote);
}

async function under(prefix: string) {
  return (await files.all()).filter((f) => f.path === prefix || f.path.startsWith(prefix + "/"));
}

function b64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function download(name: string, blob: Blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export const webHost: HostApi = {
  kind: "phone",
  getSettings: async () => publicSettings(await load()),
  async setSettings(patch) {
    const s = await load();
    const { anthropicApiKey, ...rest } = patch;
    const next: Private = { ...s, ...rest, vaultPath: undefined };
    if (anthropicApiKey !== undefined) next.anthropicApiKey = anthropicApiKey || undefined;
    await save(next);
    return publicSettings(next);
  },
  chooseVault: async () => null,
  async openVault() {
    const s = await load();
    if (!s.opened) throw new Error("No vault on this phone yet.");
    void keepStorage();
    await startSync();
    return notes();
  },
  async createVault() {
    for (const [rel, body] of Object.entries(STARTER_FILES)) if (!(await files.get(rel))) await put(rel, utf8.encode(body()));
    await save({ ...(await load()), opened: true });
    return webHost.openVault(VAULT);
  },
  async write(path, content) {
    await put(path, utf8.encode(content));
    changed();
  },
  async rename(from, to) {
    if (await files.get(to)) throw new Error(`${to} already exists`);
    for (const f of await under(from)) {
      const dest = to + f.path.slice(from.length);
      await files.put({ ...f, path: dest });
      await files.delete(f.path);
    }
    const s = await load();
    s.folders = (s.folders ?? []).map((d) => (d === from || d.startsWith(from + "/") ? to + d.slice(from.length) : d));
    await save(s);
    changed();
  },
  async remove(path) {
    for (const f of await under(path)) await files.delete(f.path);
    const s = await load();
    s.folders = (s.folders ?? []).filter((d) => d !== path && !d.startsWith(path + "/"));
    await save(s);
    changed();
  },
  async readRaw(path) {
    const f = await files.get(path);
    if (!f) throw new Error(`No file ${path}`);
    return text(f.bytes);
  },
  async readBase64(path) {
    const f = await files.get(path);
    if (!f) throw new Error(`No file ${path}`);
    return b64(f.bytes);
  },
  async listFiles() {
    const all = (await files.all()).map((f) => f.path);
    const folders = new Set((await load()).folders ?? []);
    for (const p of all) for (let i = p.indexOf("/"); i > 0; i = p.indexOf("/", i + 1)) folders.add(p.slice(0, i));
    return { files: all.filter((p) => !isNotePath(p) && !hidden(p)), folders: [...folders].filter((d) => !hidden(d)).sort() };
  },
  async saveAttachment(folder, name, bytes) {
    const clean = name.replace(/[\\/:*?"<>|#^\[\]]/g, " ").replace(/\s+/g, " ").trim() || "file";
    const dot = clean.lastIndexOf(".");
    const [base, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, ""];
    for (let i = 0; ; i++) {
      const p = `${folder ? `${folder}/` : ""}${base}${i ? ` ${i}` : ""}${ext}`;
      if (await files.get(p)) continue;
      await put(p, new Uint8Array(bytes));
      changed();
      return p;
    }
  },
  async mkdir(path) {
    const s = await load();
    s.folders = [...new Set([...(s.folders ?? []), path])];
    await save(s);
  },
  async openInSystem(path) {
    const f = await files.get(path);
    if (f) window.open(URL.createObjectURL(new Blob([f.bytes as Uint8Array<ArrayBuffer>])), "_blank");
  },
  revealInFinder: async () => {},
  async exportAsset(name) {
    const res = await fetch(`export/${encodeURIComponent(name)}`).catch(() => null);
    return res?.ok ? b64(new Uint8Array(await res.arrayBuffer())) : null;
  },
  async saveExport(name, kind, html) {
    if (kind === "pdf") throw new Error("PDF export is in the desktop app. Export HTML here and print it from the browser.");
    download(name.endsWith(".html") ? name : `${name}.html`, new Blob([html], { type: "text/html" }));
    return true;
  },
  installAgentSkills: async () => [],
  async findByName(name) {
    const want = name.toLowerCase();
    return (await files.all()).find((f) => !hidden(f.path) && f.path.split("/").pop()!.toLowerCase() === want)?.path ?? null;
  },
  listVaultPlugins: async () => [],
  history: async () => {
    throw new Error("Version history is kept on your computers. Open the note there to see its versions.");
  },
  readVersion: async () => "",
  restoreVersion: async () => "",
  syncStatus: async () => loop?.status ?? OFF,
  async turnOnSync(setup) {
    const cfg = await setUpSync(setup);
    await save({ ...(await load()), sync: cfg, opened: true });
    await startSync();
    return loop!.now();
  },
  async turnOffSync() {
    const s = await load();
    delete s.sync;
    await save(s);
    await kv.delete("syncState");
    await startSync();
    return OFF;
  },
  gitInfo: async () => ({ git: false, gh: false }),
  turnOnGitSync: async () => {
    throw new Error("Syncing with GitHub works on a computer. Turn it on there, then use a Railnote sync server for this phone.");
  },
  syncNow: async () => (loop ? loop.now() : OFF),
  onSyncEvent: syncEvents.on,
  onVaultEvent: vaultEvents.on,
  onMenuCommand: () => () => {},
  async ask(id, question, sources) {
    const s = await load();
    ask(s.anthropicApiKey, s.model, question, sources, (delta) => askEvents.emit({ id, delta }))
      .then(() => askEvents.emit({ id, done: true }))
      .catch((err) => askEvents.emit({ id, error: describeError(err), done: true }));
  },
  onAskEvent: askEvents.on,
  listAgents: async () => [],
  async organize(req) {
    const s = await load();
    try {
      return await organize(s.anthropicApiKey, s.model, req);
    } catch (err) {
      throw new Error(describeError(err));
    }
  },
  async openExternal(url) {
    if (/^https?:\/\//.test(url)) window.open(url, "_blank", "noopener");
  },
};
