import fs from "fs/promises";
import path from "path";
import chokidar, { FSWatcher } from "chokidar";
import type { NoteFile, VaultEvent } from "../shared/types";

const IGNORED = /(^|[\/\\])(\.(obsidian|git|trash|railnote)|node_modules)([\/\\]|$)/;

const toPosix = (p: string) => p.split(path.sep).join("/");

/** One open vault: a folder of Markdown files. Every path the renderer sends is vault-relative. */
export class Vault {
  private watcher?: FSWatcher;
  // Content we just wrote, so the watcher doesn't echo our own saves back as external edits.
  private ownWrites = new Map<string, string>();

  constructor(readonly root: string) {}

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

  readRaw(rel: string) {
    return fs.readFile(this.resolve(rel), "utf8");
  }

  async write(rel: string, content: string) {
    const abs = this.resolve(rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    this.ownWrites.set(rel, content);
    await fs.writeFile(abs, content, "utf8");
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
  }

  async remove(rel: string) {
    // Recoverable, like Obsidian's .trash: a delete is a move.
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
        emit({ type: "upsert", file });
      } catch {
        // Gone again before we could read it; the unlink event covers it.
      }
    };
    this.watcher.on("add", upsert).on("change", upsert).on("unlink", (abs) => {
      if (!abs.endsWith(".md")) return;
      const rel = toPosix(path.relative(this.root, abs));
      this.ownWrites.delete(rel);
      emit({ type: "delete", path: rel });
    });
  }

  async close() {
    await this.watcher?.close();
  }
}

const today = () => new Date().toISOString().slice(0, 10);

/** First-run layout: a vault that works with zero setup. */
export const STARTER_FILES: Record<string, () => string> = {
  "Welcome.md": () => `---
tags: [railnote]
---
# Welcome to Railnote

Plain Markdown files in a folder you own. No setup, no plugins to hunt for.

## What's built in
- **Daily notes**: Cmd+D opens today's note in [[Daily]].
- **Links**: type \`[[\` to link a note. Cmd+click a link to follow it. Backlinks show on the right.
- **Tasks**: every \`- [ ]\` in the vault shows up in the Tasks view.
- **Search**: Cmd+K jumps to a note, Cmd+Shift+F searches every note.
- **Inbox**: capture anything into Inbox/, then press **Organize** and Claude suggests a folder, tags and links.
- **Ask**: ask a question and get an answer from your own notes, with links to the notes it used.
- **Explainers**: an animated explainer plays inline from a \`\`\`canviz block.

## Your agents can use this vault too
Everything is a Markdown file, so Claude Code or any other agent can read and edit it. See [[AGENTS]].
Edits made outside the app show up live.

- [ ] Write your first note
- [ ] Try Cmd+K
`,
  "AGENTS.md": () => `# AGENTS.md

Instructions for AI agents working in this vault.

- Notes are Markdown. Link notes with \`[[Note name]]\`. Tags go in frontmatter \`tags: [a, b]\` or inline as #tag.
- New captures go in \`Inbox/\`. Daily notes live in \`Daily/YYYY-MM-DD.md\`.
- Tasks are \`- [ ] text\`. Mark done with \`- [x]\`.
- Don't touch \`.railnote/\` or \`.obsidian/\`.
`,
  "Inbox/.keep": () => "",
  "Notes/.keep": () => "",
  "Templates/Daily.md": () => `# {{date}}

## Plan
- [ ]

## Notes

`,
  [`Daily/${today()}.md`]: () => `# ${today()}

## Plan
- [ ] Explore [[Welcome]]

## Notes

`,
};

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
