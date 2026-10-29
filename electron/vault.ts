import fs, { constants } from "fs/promises";
import path from "path";
import chokidar, { FSWatcher } from "chokidar";
import type { NoteFile, VaultEvent, VaultListing, VersionSource } from "../shared/types";
import { History } from "./history";
import { STARTER_FILES } from "../shared/starter";

export { STARTER_FILES };

export const IGNORED = /(^|[\/\\])(\.(obsidian|git|trash|railnote|claude)|node_modules)([\/\\]|$)/;

const toPosix = (p: string) => p.split(path.sep).join("/");

/** One open vault: a folder of Markdown files. Every path the renderer sends is vault-relative. */
export class Vault {
  private watcher?: FSWatcher;
  // Content we just wrote, so the watcher doesn't echo our own saves back as external edits.
  private ownWrites = new Map<string, string>();
  // Notes that just came from another device: the watcher passes them on, labelled as such.
  private syncedWrites = new Map<string, string>();

  readonly history: History;

  constructor(readonly root: string) {
    this.history = new History(root);
  }

  /** History is a convenience: a failure there must never fail the save or move it rides on. */
  private keep(what: string, p: Promise<unknown>) {
    return p.catch((e) => console.error(`history: ${what}:`, e));
  }

  resolve(rel: string): string {
    const abs = path.resolve(this.root, rel);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) throw new Error(`outside vault: ${rel}`);
    return abs;
  }

  async readAll(): Promise<NoteFile[]> {
    const out: NoteFile[] = [];
    const walk = async (dir: string) => {
      for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
        const abs = path.join(dir, ent.name);
        const rel = toPosix(path.relative(this.root, abs));
        if (IGNORED.test(rel) || ent.name.startsWith(".")) continue;
        if (ent.isDirectory()) await walk(abs);
        else if (ent.name.endsWith(".md")) out.push(await this.readNote(rel));
      }
    };
    await walk(this.root);
    return out;
  }

  async readNote(rel: string): Promise<NoteFile> {
    const abs = this.resolve(rel);
    const [content, stat] = await Promise.all([fs.readFile(abs, "utf8"), fs.stat(abs)]);
    return { path: rel, content, mtime: stat.mtimeMs };
  }

  /** Vault path of the first file named `name` (case-insensitive), the way Obsidian resolves ![[embeds]]. */
  async findByName(name: string): Promise<string | null> {
    const want = name.toLowerCase();
    const walk = async (dir: string): Promise<string | null> => {
      for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
        const abs = path.join(dir, ent.name);
        const rel = toPosix(path.relative(this.root, abs));
        if (IGNORED.test(rel) || ent.name.startsWith(".")) continue;
        if (ent.isDirectory()) {
          const hit = await walk(abs);
          if (hit) return hit;
        } else if (ent.name.toLowerCase() === want) return rel;
      }
      return null;
    };
    return walk(this.root);
  }

  /** Everything that isn't a note: attachments and folders, empty ones included. */
  async list(): Promise<VaultListing> {
    const files: string[] = [];
    const folders: string[] = [];
    const walk = async (dir: string) => {
      for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
        const abs = path.join(dir, ent.name);
        const rel = toPosix(path.relative(this.root, abs));
        if (IGNORED.test(rel) || ent.name.startsWith(".")) continue;
        if (ent.isDirectory()) {
          folders.push(rel);
          await walk(abs);
        } else if (!ent.name.endsWith(".md")) files.push(rel);
      }
    };
    await walk(this.root);
    return { files, folders };
  }

  /** Writes bytes to `folder/name`, adding " 1", " 2"… before the extension if the name is taken. */
  async saveAttachment(folder: string, name: string, bytes: Uint8Array): Promise<string> {
    const clean = name.replace(/[\\/:*?"<>|#^\[\]]/g, " ").replace(/\s+/g, " ").trim() || "file";
    const dot = clean.lastIndexOf(".");
    const [base, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, ""];
    const dir = this.resolve(folder || ".");
    await fs.mkdir(dir, { recursive: true });
    for (let i = 0; ; i++) {
      const file = `${base}${i ? ` ${i}` : ""}${ext}`;
      try {
        await fs.writeFile(path.join(dir, file), bytes, { flag: "wx" });
        return folder ? `${folder}/${file}` : file;
      } catch (e: any) {
        if (e.code !== "EEXIST") throw e;
      }
    }
  }

  async mkdir(rel: string) {
    await fs.mkdir(this.resolve(rel), { recursive: true });
  }

  readRaw(rel: string) {
    return fs.readFile(this.resolve(rel), "utf8");
  }

  async write(rel: string, content: string, source: VersionSource = "app") {
    const abs = this.resolve(rel);
    const note = rel.endsWith(".md");
    if (note) {
      const was = await fs.readFile(abs, "utf8").catch(() => null);
      if (was !== null) await this.keep("observe", this.history.observe(rel, was));
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    this.ownWrites.set(rel, content);
    await fs.writeFile(abs, content, "utf8");
    if (note) await this.keep("record", this.history.record(rel, content, source));
  }

  /** Writes a file that arrived from another device. The watcher tells the window, as for any outside edit. */
  async writeSynced(rel: string, bytes: Uint8Array) {
    const abs = this.resolve(rel);
    if (rel.endsWith(".md")) {
      const was = await fs.readFile(abs, "utf8").catch(() => null);
      if (was !== null) await this.keep("observe", this.history.observe(rel, was));
      this.syncedWrites.set(rel, Buffer.from(bytes).toString("utf8"));
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.sync-tmp`);
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, abs);
  }

  /** Puts a saved version back, keeping the text it replaces as a version too. */
  async restore(rel: string, id: string): Promise<string> {
    const text = await this.history.read(rel, id);
    const now = await fs.readFile(this.resolve(rel), "utf8").catch(() => null);
    if (now !== null && now !== text) await this.keep("before-restore", this.history.record(rel, now, "before-restore"));
    await this.write(rel, text, "restored");
    return text;
  }

  async rename(from: string, to: string) {
    const dst = this.resolve(to);
    try {
      await fs.access(dst);
      throw new Error(`${to} already exists`);
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.rename(this.resolve(from), dst);
    await this.keep("move", this.history.move(from, to));
  }

  async remove(rel: string) {
    // The last text of each note goes into its history, so a deleted note's versions end with it.
    const notes = rel.endsWith(".md") ? [rel] : (await this.readAll()).map((n) => n.path).filter((p) => p.startsWith(rel + "/"));
    for (const n of notes) {
      const text = await fs.readFile(this.resolve(n), "utf8").catch(() => null);
      if (text !== null) await this.keep("deleted", this.history.record(n, text, "deleted"));
    }
    // Recoverable, like Obsidian's .trash: a delete is a move. Folders go whole.
    const dst = this.resolve(path.join(".trash", `${Date.now()}-${path.basename(rel)}`));
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.rename(this.resolve(rel), dst);
  }

  watch(emit: (e: VaultEvent) => void) {
    this.watcher = chokidar.watch(this.root, {
      ignored: (p: string) => IGNORED.test(toPosix(path.relative(this.root, p))),
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
    });
    const upsert = async (abs: string) => {
      if (!abs.endsWith(".md")) return;
      const rel = toPosix(path.relative(this.root, abs));
      try {
        const file = await this.readNote(rel);
        if (this.ownWrites.get(rel) === file.content) return;
        this.ownWrites.delete(rel);
        const synced = this.syncedWrites.get(rel) === file.content;
        this.syncedWrites.delete(rel);
        void this.keep("outside", this.history.record(rel, file.content, synced ? "synced" : "outside"));
        emit({ type: "upsert", file });
      } catch {
        // Gone again before we could read it; the unlink event covers it.
      }
    };
    const rel = (abs: string) => toPosix(path.relative(this.root, abs));
    const hidden = (r: string) => r.split("/").some((part) => part.startsWith("."));
    this.watcher
      .on("add", (abs) => (abs.endsWith(".md") ? upsert(abs) : !hidden(rel(abs)) && emit({ type: "file", path: rel(abs), exists: true })))
      .on("change", (abs) => (abs.endsWith(".md") ? upsert(abs) : !hidden(rel(abs)) && emit({ type: "file", path: rel(abs), exists: true })))
      .on("unlink", (abs) => {
        const r = rel(abs);
        if (hidden(r)) return;
        if (!abs.endsWith(".md")) return emit({ type: "file", path: r, exists: false });
        this.ownWrites.delete(r);
        emit({ type: "delete", path: r });
      })
      .on("addDir", (abs) => {
        const r = rel(abs);
        if (r && !hidden(r)) emit({ type: "folder", path: r, exists: true });
      })
      .on("unlinkDir", (abs) => {
        const r = rel(abs);
        if (r && !hidden(r)) emit({ type: "folder", path: r, exists: false });
      });
  }

  async close() {
    await this.watcher?.close();
  }
}

/**
 * Copies the agent skills the app ships (built into dist-electron/skills) into the vault's
 * .claude/skills, where Claude Code finds them. Returns the vault paths written.
 */
export async function installAgentSkills(dir: string, from: string, overwrite: boolean): Promise<string[]> {
  const written: string[] = [];
  for (const skill of await fs.readdir(from)) {
    for (const file of await fs.readdir(path.join(from, skill))) {
      const rel = `.claude/skills/${skill}/${file}`;
      await fs.mkdir(path.join(dir, path.dirname(rel)), { recursive: true });
      try {
        await fs.copyFile(path.join(from, skill, file), path.join(dir, rel), overwrite ? 0 : constants.COPYFILE_EXCL);
        written.push(rel);
      } catch (e: any) {
        if (e.code !== "EEXIST") throw e;
      }
    }
  }
  return written;
}

export async function createStarterVault(dir: string) {
  for (const [rel, body] of Object.entries(STARTER_FILES)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    try {
      await fs.writeFile(abs, body(), { flag: "wx" });
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
    }
  }
}
