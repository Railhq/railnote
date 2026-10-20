import type { HostApi, OrganizeSuggestion, Settings } from "../shared/types";
import { setFrontmatterTags, LINK_RE } from "./lib/parse";
import { VaultIndex, escapeRe, noteFolder, noteName } from "./lib/vault-index";

export const host: HostApi = (window as any).railnote;

const pad = (n: number) => String(n).padStart(2, "0");
export const isoDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const join = (folder: string, file: string) => (folder ? `${folder}/${file}` : file);

/** Vault operations that touch more than one file or need the index. UI state stays in React. */
export class Workspace {
  index = new VaultIndex();

  constructor(public settings: Settings) {}

  async write(path: string, content: string) {
    await host.write(path, content);
    this.index.upsert({ path, content, mtime: Date.now() });
  }

  uniquePath(folder: string, base: string): string {
    const clean = base.replace(/[\\/:*?"<>|#^\[\]]/g, " ").replace(/\s+/g, " ").trim() || "Untitled";
    let p = join(folder, `${clean}.md`);
    for (let i = 2; this.index.notes.has(p); i++) p = join(folder, `${clean} ${i}.md`);
    return p;
  }

  async createNote(folder: string, name = "Untitled", content = ""): Promise<string> {
    const p = this.uniquePath(folder, name);
    await this.write(p, content);
    return p;
  }

  /** Today's daily note, created from Templates/Daily.md when it doesn't exist yet. */
  async daily(date = isoDate()): Promise<string> {
    const p = join(this.settings.dailyFolder, `${date}.md`);
    if (this.index.notes.has(p)) return p;
    const tpl = this.index.notes.get(join(this.settings.templatesFolder, "Daily.md"));
    await this.write(p, tpl ? this.fillTemplate(tpl.content, date) : `# ${date}\n\n`);
    return p;
  }

  fillTemplate(src: string, date = isoDate()) {
    const now = new Date();
    return src
      .replace(/\{\{date\}\}/g, date)
      .replace(/\{\{time\}\}/g, `${pad(now.getHours())}:${pad(now.getMinutes())}`);
  }

  templates() {
    const prefix = this.settings.templatesFolder + "/";
    return this.index.all().filter((n) => n.path.startsWith(prefix));
  }

  /** Follows a [[link]]: opens the note, or creates it in Notes/ the first time. */
  async resolveOrCreate(target: string): Promise<string> {
    const name = target.split("#")[0].trim();
    const hit = this.index.resolve(name);
    if (hit) return hit;
    const folder = name.includes("/") ? noteFolder(name) : "Notes";
    return this.createNote(folder, noteName(name), `# ${noteName(name)}\n\n`);
  }

  /** Renames or moves a note and rewrites [[links]] to it across the vault. */
  async rename(from: string, to: string): Promise<string> {
    if (from === to) return from;
    if (this.index.notes.has(to)) throw new Error(`${to} already exists`);
    const oldName = noteName(from);
    const newName = noteName(to);
    const pathKey = from.replace(/\.md$/, "");
    await host.rename(from, to);
    const moved = this.index.notes.get(from);
    this.index.remove(from);
    if (moved) this.index.upsert({ path: to, content: moved.content, mtime: Date.now() });

    if (oldName !== newName || noteFolder(from) !== noteFolder(to)) {
      const re = new RegExp(`(!?)\\[\\[(${escapeRe(oldName)}|${escapeRe(pathKey)})(#[^\\]|\\n]*)?(\\|[^\\]\\n]*)?\\]\\]`, "gi");
      const target = this.index.resolve(newName) === to ? newName : to.replace(/\.md$/, "");
      for (const n of this.index.all()) {
        if (!n.parsed.links.length) continue;
        const next = n.content.replace(re, (_m, bang, _t, head = "", alias = "") => `${bang}[[${target}${head}${alias}]]`);
        if (next !== n.content) await this.write(n.path, next);
      }
    }
    return to;
  }

  async toggleTask(path: string, line: number) {
    const n = this.index.notes.get(path);
    if (!n) return;
    const lines = n.content.split("\n");
    lines[line] = lines[line].replace(/\[([ xX])\]/, (_m, c) => (c === " " ? "[x]" : "[ ]"));
    await this.write(path, lines.join("\n"));
  }

  async applyOrganize(path: string, s: OrganizeSuggestion, pick: { folder: boolean; tags: string[]; links: string[] }): Promise<string> {
    const n = this.index.notes.get(path);
    if (!n) return path;
    let content = n.content;
    if (pick.tags.length) content = setFrontmatterTags(content, [...new Set([...n.parsed.tags, ...pick.tags])]);
    const existing = new Set(n.parsed.links.map((l) => l.target.toLowerCase()));
    const add = pick.links.filter((l) => !existing.has(l.toLowerCase()));
    if (add.length) content = content.replace(/\s*$/, "") + `\n\n## Related\n${add.map((l) => `- [[${l}]]`).join("\n")}\n`;
    if (content !== n.content) await this.write(path, content);
    if (pick.folder && s.folder !== n.folder) return this.rename(path, this.uniquePath(s.folder, n.name));
    return path;
  }

  /** Every [[target]] in the vault that resolves to nothing. */
  unresolvedLinks(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const n of this.index.notes.values()) {
      for (const l of n.parsed.links) {
        if (/\.\w+$/.test(l.target) && !l.target.endsWith(".md")) continue;
        if (!this.index.resolve(l.target)) out.set(l.target, [...(out.get(l.target) ?? []), n.path]);
      }
    }
    return out;
  }
}

export { LINK_RE };
