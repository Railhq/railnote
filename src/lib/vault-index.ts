import MiniSearch from "minisearch";
import { stripNoteExt, type NoteFile, type VaultListing } from "../../shared/types";
import { parse, Parsed } from "./parse";

export interface Note extends NoteFile {
  name: string;
  folder: string;
  parsed: Parsed;
}

export const noteName = (path: string) => stripNoteExt(path.replace(/^.*\//, ""));
export const noteFolder = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
export const fileName = (path: string) => path.replace(/^.*\//, "");
export const extOf = (name: string) => /\.([\w-]+)$/.exec(name)?.[1].toLowerCase() ?? "";

export const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"]);
export const AUDIO_EXT = new Set(["mp3", "wav", "m4a", "ogg", "flac"]);
export const VIDEO_EXT = new Set(["mp4", "webm", "mov"]);
/** Files Railnote opens in its own plain-text editor rather than another app. */
export const TEXT_EXT = new Set([
  "txt", "json", "py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "css", "scss", "html", "xml", "yaml", "yml", "toml", "ini", "cfg",
  "csv", "tsv", "log", "sh", "bash", "zsh", "sql", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "hpp", "cs", "php",
  "lua", "r", "tex", "bib", "ipynb",
]);
export const isMedia = (ext: string) => IMAGE_EXT.has(ext) || AUDIO_EXT.has(ext) || VIDEO_EXT.has(ext) || ext === "pdf";

/** In-memory model of the vault: notes, link graph, tags, tasks and full-text search. */
export class VaultIndex {
  notes = new Map<string, Note>();
  /** Attachments: every file that isn't a note, with a counter bumped when one changes on disk. */
  files = new Map<string, number>();
  /** Folders seen on disk, so empty ones still show. */
  dirs = new Set<string>();
  version = 0;
  private search = this.makeSearch();
  private byKey = new Map<string, string>(); // lowercase name / path / alias -> path
  private listeners = new Set<() => void>();

  private makeSearch() {
    return new MiniSearch<{ id: string; name: string; content: string }>({
      fields: ["name", "content"],
      storeFields: ["name"],
      searchOptions: { boost: { name: 3 }, prefix: true, fuzzy: 0.15 },
    });
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private changed() {
    this.version++;
    this.rebuildKeys();
    this.listeners.forEach((fn) => fn());
  }

  load(files: NoteFile[]) {
    this.notes.clear();
    this.search = this.makeSearch();
    for (const f of files) this.put(f, false);
    this.changed();
  }

  upsert(file: NoteFile) {
    this.put(file, true);
    this.changed();
  }

  setListing(l: VaultListing) {
    this.files = new Map(l.files.map((f) => [f, 0]));
    this.dirs = new Set(l.folders);
    this.changed();
  }

  setFile(path: string, exists: boolean) {
    if (exists) this.files.set(path, (this.files.get(path) ?? -1) + 1);
    else this.files.delete(path);
    this.changed();
  }

  setFolder(path: string, exists: boolean) {
    if (exists) this.dirs.add(path);
    else for (const d of [...this.dirs]) if (d === path || d.startsWith(path + "/")) this.dirs.delete(d);
    this.changed();
  }

  /** Resolves an attachment the way Obsidian does: the path as written, next to the note, then by file name anywhere. */
  resolveFile(src: string, fromFolder = ""): string | null {
    const s = src.trim().replace(/^\.\//, "");
    if (this.files.has(s) || this.notes.has(s)) return s;
    const near = fromFolder ? `${fromFolder}/${s}` : s;
    if (this.files.has(near) || this.notes.has(near)) return near;
    const want = fileName(s).toLowerCase();
    let best: string | null = null;
    for (const f of this.files.keys()) if (fileName(f).toLowerCase() === want && (!best || f.length < best.length)) best = f;
    return best;
  }

  remove(path: string) {
    if (this.notes.has(path)) this.search.discard(path);
    this.notes.delete(path);
    this.changed();
  }

  private put(f: NoteFile, replace: boolean) {
    const note: Note = { ...f, name: noteName(f.path), folder: noteFolder(f.path), parsed: parse(f.content) };
    const doc = { id: f.path, name: note.name, content: f.content };
    if (replace && this.notes.has(f.path)) this.search.replace(doc);
    else this.search.add(doc);
    this.notes.set(f.path, note);
  }

  private rebuildKeys() {
    this.byKey.clear();
    // Shortest path wins on duplicate names, matching Obsidian's "shortest path when possible".
    const sorted = [...this.notes.values()].sort((a, b) => a.path.length - b.path.length);
    for (const n of sorted) {
      for (const k of [n.name, stripNoteExt(n.path), n.path, ...n.parsed.aliases]) {
        const key = k.toLowerCase();
        if (!this.byKey.has(key)) this.byKey.set(key, n.path);
      }
    }
  }

  /** Resolves a [[link]] target to a note path, or null for an unresolved link. */
  resolve(target: string): string | null {
    return this.byKey.get(target.trim().toLowerCase()) ?? null;
  }

  all(): Note[] {
    return [...this.notes.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  folders(): string[] {
    const set = new Set<string>(this.dirs);
    for (const f of this.files.keys()) {
      const parts = noteFolder(f) ? noteFolder(f).split("/") : [];
      for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join("/"));
    }
    for (const n of this.notes.values()) {
      const parts = n.folder ? n.folder.split("/") : [];
      for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join("/"));
    }
    return [...set].sort();
  }

  tags(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const n of this.notes.values()) for (const t of n.parsed.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return counts;
  }

  backlinks(path: string): { source: Note; lines: string[] }[] {
    const out: { source: Note; lines: string[] }[] = [];
    for (const n of this.notes.values()) {
      if (n.path === path) continue;
      const hits = n.parsed.links.filter((l) => this.resolve(l.target) === path);
      if (hits.length) {
        const lines = n.content.split("\n");
        out.push({ source: n, lines: [...new Set(hits.map((h) => lines[h.line].trim()))] });
      }
    }
    return out.sort((a, b) => a.source.name.localeCompare(b.source.name));
  }

  /** Notes that mention this note's name or alias as plain text without linking it. */
  unlinkedMentions(path: string): { source: Note; lines: string[] }[] {
    const target = this.notes.get(path);
    if (!target) return [];
    const names = [target.name, ...target.parsed.aliases].filter((s) => s.length >= 3);
    if (!names.length) return [];
    const re = new RegExp(`\\b(${names.map(escapeRe).join("|")})\\b`, "i");
    const out: { source: Note; lines: string[] }[] = [];
    for (const n of this.notes.values()) {
      if (n.path === path) continue;
      const lines = n.content
        .slice(n.parsed.bodyStart)
        .split("\n")
        .filter((l) => re.test(l.replace(/\[\[[^\]]*\]\]/g, "")));
      if (lines.length) out.push({ source: n, lines: lines.slice(0, 3).map((l) => l.trim()) });
    }
    return out;
  }

  searchText(query: string, limit = 50) {
    if (!query.trim()) return [];
    return this.search.search(query).slice(0, limit).map((r) => ({ path: r.id as string, score: r.score, terms: r.terms }));
  }

  /** Fuzzy name match for the quick switcher. */
  quickFind(query: string, limit = 30): Note[] {
    const q = query.toLowerCase().trim();
    const all = this.all();
    if (!q) return all.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
    const scored: [number, Note][] = [];
    for (const n of all) {
      const hay = [n.name, ...n.parsed.aliases].map((s) => s.toLowerCase());
      let best = -1;
      for (const h of hay) {
        if (h === q) best = Math.max(best, 100);
        else if (h.startsWith(q)) best = Math.max(best, 80);
        else if (h.includes(q)) best = Math.max(best, 60);
        else if (subsequence(q, h)) best = Math.max(best, 30);
      }
      if (best < 0 && n.path.toLowerCase().includes(q)) best = 20;
      if (best >= 0) scored.push([best - n.name.length / 100, n]);
    }
    return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map((s) => s[1]);
  }
}

function subsequence(q: string, h: string) {
  let i = 0;
  for (const c of h) if (c === q[i]) i++;
  return i === q.length;
}

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Best-matching passages of a note for a query, used to keep Ask prompts small. */
export function excerpt(content: string, terms: string[], budget = 1800): string {
  if (content.length <= budget) return content;
  const paras = content.split(/\n\s*\n/);
  const lower = terms.map((t) => t.toLowerCase());
  const scored = paras.map((p, i) => ({ i, p, s: lower.reduce((acc, t) => acc + (p.toLowerCase().includes(t) ? 1 : 0), 0) }));
  const keep = new Set<number>([0]);
  let used = paras[0].length;
  for (const { i, p, s } of scored.sort((a, b) => b.s - a.s)) {
    if (s === 0 || used + p.length > budget) continue;
    keep.add(i);
    used += p.length;
  }
  return [...keep].sort((a, b) => a - b).map((i) => paras[i]).join("\n\n…\n\n").slice(0, budget * 1.2);
}
