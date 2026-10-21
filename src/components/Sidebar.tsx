import { useEffect, useMemo, useState } from "react";
import { fileName, noteFolder, type Note } from "../lib/vault-index";
import { host, type Workspace } from "../workspace";
import { whereFrom, type OpenWhere } from "../editor/hooks";

export type MainView = "home" | "note" | "tasks" | "inbox" | "source" | "graph";

export type EntryKind = "note" | "file" | "folder";
interface Entry {
  kind: EntryKind;
  path: string;
}

interface Props {
  ws: Workspace;
  current: string | null;
  view: MainView;
  onOpen(path: string, where?: OpenWhere): void;
  onView(v: MainView): void;
  onNew(folder?: string): void;
  onDaily(): void;
  onSettings(): void;
  onDelete(path: string, kind: EntryKind): void;
  /** Renames or moves a note, attachment or folder. `to` is the full new vault path. */
  onMove(kind: EntryKind, from: string, to: string): Promise<void>;
  onOpenFile(path: string): void;
  /** Bumped by Cmd+Shift+F to switch to the search tab. */
  searchKey: number;
}

interface Tree {
  folders: Map<string, Tree>;
  items: { kind: "note" | "file"; path: string; name: string }[];
}

function buildTree(notes: Note[], files: string[], folders: string[]): Tree {
  const root: Tree = { folders: new Map(), items: [] };
  const at = (folder: string) => {
    let node = root;
    if (folder) for (const part of folder.split("/")) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), items: [] });
      node = node.folders.get(part)!;
    }
    return node;
  };
  folders.forEach(at);
  for (const n of notes) at(n.folder).items.push({ kind: "note", path: n.path, name: n.name });
  for (const f of files) at(noteFolder(f)).items.push({ kind: "file", path: f, name: fileName(f) });
  return root;
}

const DRAG_TYPE = "application/x-railnote-entry";
const parentOf = (p: string) => noteFolder(p);
const joinPath = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

export function Sidebar(p: Props) {
  const [tab, setTab] = useState<"files" | "search" | "tags">("files");
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; entry: Entry | null } | null>(null);
  const [editing, setEditing] = useState<Entry | null>(null);
  const [moving, setMoving] = useState<Entry | null>(null);
  const [dropAt, setDropAt] = useState<string | null>(null);
  const idx = p.ws.index;
  useEffect(() => {
    if (p.searchKey) setTab("search");
  }, [p.searchKey]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [menu]);
  const inboxCount = idx.all().filter((n) => n.folder === p.ws.settings.inboxFolder).length;
  const openTasks = useMemo(() => idx.all().reduce((a, n) => a + n.parsed.tasks.filter((t) => !t.done).length, 0), [idx.version]);
  const tree = useMemo(() => buildTree(idx.all(), [...idx.files.keys()], idx.folders()), [idx.version]);
  const results = useMemo(() => idx.searchText(query, 60), [query, idx.version]);

  const toggle = (k: string) => setClosed((s) => {
    const n = new Set(s);
    n.has(k) ? n.delete(k) : n.add(k);
    return n;
  });

  const move = async (e: Entry, to: string) => {
    if (to === e.path) return;
    try {
      await p.onMove(e.kind, e.path, to);
    } catch (err) {
      alert((err as Error).message);
    }
  };
  /** Where an entry lands when dropped into `folder`, or null when that's a no-op or impossible. */
  const dropTarget = (e: Entry, folder: string) => {
    if (parentOf(e.path) === folder) return null;
    if (e.kind === "folder" && (folder === e.path || folder.startsWith(e.path + "/"))) return null;
    return joinPath(folder, fileName(e.path));
  };
  const newFolder = async (parent: string) => {
    let path = joinPath(parent, "New folder");
    for (let i = 2; idx.folders().includes(path); i++) path = joinPath(parent, `New folder ${i}`);
    await p.ws.createFolder(path);
    setClosed((s) => {
      const n = new Set(s);
      n.delete(parent);
      return n;
    });
    setEditing({ kind: "folder", path });
  };
  const commitRename = async (e: Entry, raw: string) => {
    setEditing(null);
    const name = raw.trim().replace(/[\\/:*?"<>|]/g, " ");
    if (!name) return;
    const full = e.kind === "note" ? `${name}.md` : name;
    if (full === fileName(e.path)) return;
    await move(e, joinPath(parentOf(e.path), full));
  };

  const dragProps = (e: Entry) => ({
    draggable: editing?.path !== e.path,
    onDragStart: (ev: React.DragEvent) => {
      ev.dataTransfer.setData(DRAG_TYPE, JSON.stringify(e));
      ev.dataTransfer.effectAllowed = "move";
    },
  });
  const dropProps = (folder: string) => ({
    onDragOver: (ev: React.DragEvent) => {
      if (!ev.dataTransfer.types.includes(DRAG_TYPE)) return;
      ev.preventDefault();
      ev.stopPropagation();
      ev.dataTransfer.dropEffect = "move";
      if (dropAt !== folder) setDropAt(folder);
    },
    onDragLeave: (ev: React.DragEvent) => {
      if (!(ev.currentTarget as HTMLElement).contains(ev.relatedTarget as Node)) setDropAt((d) => (d === folder ? null : d));
    },
    onDrop: (ev: React.DragEvent) => {
      const raw = ev.dataTransfer.getData(DRAG_TYPE);
      setDropAt(null);
      if (!raw) return;
      ev.preventDefault();
      ev.stopPropagation();
      const e = JSON.parse(raw) as Entry;
      const to = dropTarget(e, folder);
      if (to) void move(e, to);
    },
  });
  const openMenu = (ev: React.MouseEvent, entry: Entry | null) => {
    ev.preventDefault();
    ev.stopPropagation();
    setMenu({ x: ev.clientX, y: ev.clientY, entry });
  };

  const label = (e: Entry, name: string) =>
    editing?.path === e.path ? (
      <input
        className="tree-rename"
        autoFocus
        defaultValue={name}
        onFocus={(ev) => ev.currentTarget.select()}
        onClick={(ev) => ev.stopPropagation()}
        onKeyDown={(ev) => {
          if (ev.key === "Enter") void commitRename(e, ev.currentTarget.value);
          if (ev.key === "Escape") setEditing(null);
        }}
        onBlur={(ev) => void commitRename(e, ev.currentTarget.value)}
      />
    ) : (
      name
    );

  // The tree is drawn as a line map: each folder is a line, each note a stop on it.
  const stopX = (depth: number) => 20 + Math.max(depth - 1, 0) * 14;
  const renderTree = (t: Tree, prefix: string, depth: number, line = "var(--line-0)"): JSX.Element[] => {
    const out: JSX.Element[] = [];
    const sorted = t.items.sort((a, b) => a.name.localeCompare(b.name));
    sorted.forEach((it, i) => {
      const e: Entry = { kind: it.kind, path: it.path };
      const active = it.kind === "note" && it.path === p.current && p.view === "note";
      out.push(
        <div
          key={it.path}
          className={`tree-note${it.kind === "file" ? " file" : ""}${active ? " active" : ""}${i === sorted.length - 1 ? " last" : ""}`}
          style={{ "--x": `${stopX(depth)}px`, "--track": line } as React.CSSProperties}
          onClick={(ev) => (it.kind === "note" ? p.onOpen(it.path, whereFrom(ev)) : p.onOpenFile(it.path))}
          onContextMenu={(ev) => openMenu(ev, e)}
          title={it.path}
          {...dragProps(e)}
        >
          {label(e, it.name)}
        </div>,
      );
    });
    [...t.folders].sort((a, b) => a[0].localeCompare(b[0])).forEach(([name, sub], i) => {
      const key = prefix ? `${prefix}/${name}` : name;
      const isClosed = closed.has(key);
      const color = depth === 0 ? `var(--line-${(i % 4) + 1})` : line;
      const e: Entry = { kind: "folder", path: key };
      out.push(
        <div key={"g:" + key} className={`tree-group${dropAt === key ? " drop" : ""}`} {...dropProps(key)}>
          <div
            className={`tree-folder${isClosed ? " closed" : ""}`}
            style={{ "--x": `${stopX(depth + 1)}px`, "--track": color } as React.CSSProperties}
            onClick={() => toggle(key)}
            onContextMenu={(ev) => openMenu(ev, e)}
            title={isClosed ? "Show notes" : "Hide notes"}
            {...dragProps(e)}
          >
            {label(e, name)}
          </div>
          {!isClosed && renderTree(sub, key, depth + 1, color)}
        </div>,
      );
    });
    return out;
  };

  const menuItems = (e: Entry | null): [string, () => void][] => {
    if (!e) return [["New note", () => p.onNew("")], ["New folder", () => void newFolder("")]];
    const name = e.kind === "note" ? fileName(e.path).replace(/\.md$/, "") : fileName(e.path);
    const common: [string, () => void][] = [
      ["Rename", () => setEditing(e)],
      ["Move to…", () => setMoving(e)],
      ["Show in Finder", () => void host.revealInFinder(e.path)],
      ["Delete", () => {
        const what = e.kind === "folder" ? `the folder "${name}" and everything in it` : `"${name}"`;
        if (confirm(`Move ${what} to the vault's .trash folder?`)) p.onDelete(e.path, e.kind);
      }],
    ];
    if (e.kind === "folder") return [["New note here", () => p.onNew(e.path)], ["New folder here", () => void newFolder(e.path)], ...common];
    if (e.kind === "note") return [["Open in new tab", () => p.onOpen(e.path, "tab")], ["Open to the side", () => p.onOpen(e.path, "split")], ...common];
    return [["Open", () => p.onOpenFile(e.path)], ...common];
  };

  return (
    <aside className="sidebar">
      <div className="drag-region" />
      <div className="nav">
        <button className="nav-new" onClick={() => p.onNew()} title="New note in the inbox (⌘N)">New note</button>
        <button className={p.view === "home" ? "on" : ""} onClick={() => p.onView("home")} title="Today: your note, the inbox, what's left to do">Today</button>
        <button className={p.view === "inbox" ? "on" : ""} onClick={() => p.onView("inbox")}>
          Inbox {inboxCount > 0 && <span className="count">{inboxCount}</span>}
        </button>
        <button className={p.view === "tasks" ? "on" : ""} onClick={() => p.onView("tasks")}>
          Tasks {openTasks > 0 && <span className="count">{openTasks}</span>}
        </button>
        <button className={p.view === "graph" ? "on" : ""} onClick={() => p.onView("graph")} title="How your notes link up (⌥⌘G)">
          Graph
        </button>
      </div>
      <div className="tabs">
        {(["files", "search", "tags"] as const).map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <div className="side-body">
        {tab === "files" && (
          <div className={`tree-root${dropAt === "" ? " drop" : ""}`} onContextMenu={(ev) => openMenu(ev, null)} {...dropProps("")}>
            {renderTree(tree, "", 0)}
          </div>
        )}
        {tab === "search" && (
          <>
            <input className="side-search" autoFocus placeholder="Search all notes" value={query} onChange={(e) => setQuery(e.target.value)} />
            {results.map((r) => {
              const n = idx.notes.get(r.path)!;
              const line = n.content.split("\n").find((l) => r.terms.some((t) => l.toLowerCase().includes(t))) ?? "";
              return (
                <div key={r.path} className="search-hit" onClick={() => p.onOpen(r.path)}>
                  <div className="search-name">{n.name}</div>
                  <div className="search-line">{line.trim().slice(0, 140)}</div>
                </div>
              );
            })}
            {query && !results.length && <div className="empty">Nothing found</div>}
          </>
        )}
        {tab === "tags" &&
          [...idx.tags()].sort((a, b) => b[1] - a[1]).map(([tag, count]) => (
            <div key={tag} className="tag-row" onClick={() => { setTab("search"); setQuery(tag); }}>
              <span>#{tag}</span>
              <span className="count">{count}</span>
            </div>
          ))}
      </div>
      {menu && (
        <div className="menu" style={{ left: Math.min(menu.x, window.innerWidth - 200), top: Math.min(menu.y, window.innerHeight - 220) }} onMouseDown={(ev) => ev.stopPropagation()}>
          {menuItems(menu.entry).map(([text, run]) => (
            <button key={text} className={text === "Delete" ? "danger" : ""} onClick={() => { setMenu(null); run(); }}>
              {text}
            </button>
          ))}
        </div>
      )}
      {moving && <MovePicker ws={p.ws} entry={moving} onClose={() => setMoving(null)} onPick={(folder) => {
        const to = dropTarget(moving, folder);
        setMoving(null);
        if (to) void move(moving, to);
      }} />}
      <div className="side-foot">
        <button onClick={p.onSettings}>Settings</button>
      </div>
    </aside>
  );
}

/** "Move to…": every folder the entry could go into, filtered as you type. */
function MovePicker({ ws, entry, onClose, onPick }: { ws: Workspace; entry: Entry; onClose(): void; onPick(folder: string): void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const options = useMemo(() => {
    const all = ["", ...ws.index.folders().filter((f) => !f.split("/").some((s) => s.startsWith(".")))].filter(
      (f) => f !== noteFolder(entry.path) && !(entry.kind === "folder" && (f === entry.path || f.startsWith(entry.path + "/"))),
    );
    const t = q.trim().toLowerCase();
    return t ? all.filter((f) => f.toLowerCase().includes(t)) : all;
  }, [q]);
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder={`Move ${fileName(entry.path)} to…`}
          value={q}
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, options.length - 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            if (e.key === "Enter" && options[sel] !== undefined) onPick(options[sel]);
          }}
        />
        <div className="palette-list">
          {options.map((f, i) => (
            <div key={f || "/"} className={`palette-item${i === sel ? " sel" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => onPick(f)}>
              {f || "Vault root"}
            </div>
          ))}
          {!options.length && <div className="empty">No folder matches</div>}
        </div>
      </div>
    </div>
  );
}
