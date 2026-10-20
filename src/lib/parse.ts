// Markdown facts the app needs: frontmatter, links, tags, tasks, headings. Obsidian-compatible syntax.

export interface Link {
  target: string;
  heading?: string;
  alias?: string;
  embed: boolean;
  line: number;
}

export interface Task {
  line: number;
  done: boolean;
  text: string;
}

export interface Parsed {
  frontmatter: Record<string, unknown>;
  bodyStart: number;
  aliases: string[];
  tags: string[];
  links: Link[];
  tasks: Task[];
  headings: { level: number; text: string; line: number }[];
}

const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Small YAML subset: scalars, inline lists, dash lists. Enough for aliases/tags/dates. */
export function parseFrontmatter(src: string): { data: Record<string, unknown>; end: number } {
  const m = FM.exec(src);
  if (!m) return { data: {}, end: 0 };
  const data: Record<string, unknown> = {};
  let key: string | null = null;
  for (const raw of m[1].split(/\r?\n/)) {
    const item = /^\s+-\s*(.*)$/.exec(raw);
    if (item && key) {
      const list = Array.isArray(data[key]) ? (data[key] as unknown[]) : (data[key] = []);
      (list as unknown[]).push(unquote(item[1]));
      continue;
    }
    const kv = /^([\w-]+):\s*(.*)$/.exec(raw);
    if (!kv) continue;
    key = kv[1];
    const v = kv[2].trim();
    if (v.startsWith("[") && v.endsWith("]")) data[key] = v.slice(1, -1).split(",").map((s) => unquote(s.trim())).filter(Boolean);
    else data[key] = v === "" ? [] : unquote(v);
  }
  return { data, end: m[0].length };
}

const unquote = (s: string) => s.replace(/^["']|["']$/g, "");

const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? v.split(/[,\s]+/).filter(Boolean) : [];

export const LINK_RE = /(!?)\[\[([^\]\|#\n]*)(#[^\]\|\n]*)?(?:\|([^\]\n]*))?\]\]/g;
const TAG_RE = /(^|[\s(])#([A-Za-z0-9_][\w\/-]*)/g;
const TASK_RE = /^\s*[-*+] \[([ xX])\] (.*)$/;

export function parse(src: string): Parsed {
  const { data, end } = parseFrontmatter(src);
  const tags = new Set(asList(data.tags).map((t) => t.replace(/^#/, "")));
  const links: Link[] = [];
  const tasks: Task[] = [];
  const headings: Parsed["headings"] = [];

  const lines = src.split("\n");
  const fmLines = end ? src.slice(0, end).split("\n").length - 1 : 0;
  let fence = false;
  for (let i = fmLines; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) headings.push({ level: h[1].length, text: h[2].trim(), line: i });
    const t = TASK_RE.exec(line);
    if (t) tasks.push({ line: i, done: t[1] !== " ", text: t[2] });
    const stripped = line.replace(/`[^`]*`/g, "");
    for (const m of stripped.matchAll(LINK_RE)) {
      if (!m[2].trim()) continue;
      links.push({ embed: m[1] === "!", target: m[2].trim(), heading: m[3]?.slice(1), alias: m[4], line: i });
    }
    if (!h) for (const m of stripped.matchAll(TAG_RE)) tags.add(m[2]);
  }
  return { frontmatter: data, bodyStart: end, aliases: asList(data.aliases ?? data.alias), tags: [...tags], links, tasks, headings };
}

/** Rewrites the frontmatter `tags` list, creating frontmatter if the note has none. */
export function setFrontmatterTags(src: string, tags: string[]): string {
  const list = `tags: [${tags.join(", ")}]`;
  const m = FM.exec(src);
  if (!m) return `---\n${list}\n---\n${src}`;
  const body = m[1];
  // Drop an existing tags entry (inline or dash list), then append the new one.
  const kept = body.replace(/^tags:.*(\r?\n\s+-.*)*/m, "").replace(/\n{2,}/g, "\n").trim();
  return `---\n${kept ? kept + "\n" : ""}${list}\n---\n${src.slice(m[0].length)}`;
}
