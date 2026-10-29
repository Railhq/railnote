import { useEffect, useMemo, useRef, useState } from "react";
import { fileName, noteFolder, type Note } from "../lib/vault-index";
import { host, type Workspace } from "../workspace";
import { whereFrom, type OpenWhere } from "../editor/hooks";
import { folderLines, lineColour } from "../lib/lines";

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
  /** What the sync line under the tree says, or null with sync off. */
  syncLine?: string | null;
  syncError?: string;
  onSyncNow?(): void;
  onDelete(path: string, kind: EntryKind): void;
  /** Renames or moves a note, attachment or folder. `to` is the full new vault path. */
  onMove(kind: EntryKind, from: string, to: string): Promise<void>;
  onOpenFile(path: string): void;
  /** Bumped by Cmd+Shift+F to switch to the search tab. */
  searchKey: number;
  /** Folded down to a slim rail so the page has the window; the full sidebar peeks out over it. */
  folded: boolean;
  onFold(folded: boolean): void;
  /** Phone width: the rail is a bar along the bottom, and the notes open over the whole page. */
  narrow?: boolean;
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
  const [peek, setPeek] = useState(false);
  const peekTimer = useRef(0);
  // On a phone the notes cover the page, so going anywhere from them puts them away, even to the note already open.
  const away = () => p.narrow && setPeek(false);
  const onOpen: Props["onOpen"] = (...a) => (away(), p.onOpen(...a));
  const onView: Props["onView"] = (...a) => (away(), p.onView(...a));
  const onOpenFile: Props["onOpenFile"] = (...a) => (away(), p.onOpenFile(...a));
  const onNew: Props["onNew"] = (...a) => (away(), p.onNew(...a));
  useEffect(() => {
    if (!p.searchKey) return;
    setTab("search");
    if (p.folded) setPeek(true);
  }, [p.searchKey]);
  // Going somewhere puts the peeking sidebar away again.
  useEffect(() => setPeek(false), [p.current, p.view, p.folded]);
  useEffect(() => {
    if (!peek) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPeek(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [peek]);
  const peekSoon = () => { clearTimeout(peekTimer.current); peekTimer.current = window.setTimeout(() => setPeek(true), 180); };
  const stayPut = () => clearTimeout(peekTimer.current);
  // Leaving the peek closes it, unless a menu or a rename is still open in it.
  const leavePeek = () => { stayPut(); if (!menu && !editing && !moving) peekTimer.current = window.setTimeout(() => setPeek(false), 260); };
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
          onClick={(ev) => (it.kind === "note" ? onOpen(it.path, whereFrom(ev)) : onOpenFile(it.path))}
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
    if (!e) return [["New note", () => onNew("")], ["New folder", () => void newFolder("")]];
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
    if (e.kind === "folder") return [["New note here", () => onNew(e.path)], ["New folder here", () => void newFolder(e.path)], ...common];
    if (e.kind === "note") return [["Open in new tab", () => onOpen(e.path, "tab")], ["Open to the side", () => onOpen(e.path, "split")], ...common];
    return [["Open", () => onOpenFile(e.path)], ...common];
  };

  const lines = folderLines(idx);
  const today = new Date();
  const slim = (
    <aside className="sidebar slim" aria-label="Sidebar, folded" onMouseLeave={() => peek && !p.narrow && leavePeek()}>
      <div className="drag-region" />
      <button className="slim-new" onClick={() => onNew()} title="New note in the inbox (⌘N)" aria-label="New note">+</button>
      <button className={`slim-btn${p.view === "home" ? " on" : ""}`} onClick={() => onView("home")} title="Today" aria-label="Today">
        <span className="slim-day">{today.getDate()}</span>
      </button>
      <button className={`slim-btn${p.view === "inbox" ? " on" : ""}`} onClick={() => onView("inbox")} title={`Inbox${inboxCount ? `, ${inboxCount} waiting` : ""}`} aria-label="Inbox">
        <svg viewBox="0 0 20 20"><path d="M3 11.5 5 4h10l2 7.5V16H3z M3 11.5h4.5l1 2h3l1-2H17" /></svg>
        {inboxCount > 0 && <span className="slim-badge">{inboxCount}</span>}
      </button>
      <button className={`slim-btn${p.view === "tasks" ? " on" : ""}`} onClick={() => onView("tasks")} title={`Tasks${openTasks ? `, ${openTasks} open` : ""}`} aria-label="Tasks">
        <svg viewBox="0 0 20 20"><rect x="3.5" y="3.5" width="13" height="13" rx="3" /><path d="m7 10 2.2 2.2L13.5 8" /></svg>
        {openTasks > 0 && <span className="slim-badge">{openTasks}</span>}
      </button>
      <button className={`slim-btn${p.view === "graph" ? " on" : ""}`} onClick={() => onView("graph")} title="Graph (⌥⌘G)" aria-label="Graph">
        <svg viewBox="0 0 20 20"><path d="M4 15 9 10h7" /><circle cx="4" cy="15" r="2" /><circle cx="9.5" cy="10" r="2" /><circle cx="16" cy="10" r="2" /></svg>
      </button>
      {/* The folders as a strip of line colours; pointing at it opens the full map of notes. */}
      <button className={`slim-lines${peek ? " on" : ""}`} onMouseEnter={p.narrow ? undefined : peekSoon} onMouseLeave={stayPut} onClick={() => setPeek(p.narrow ? !peek : true)} title="Your notes" aria-label="Show your notes">
        {lines.map((l) => <i key={l} style={{ background: lineColour(lines, l + "/") }} title={l} />)}
      </button>
      <div className="slim-foot">
        <button className="slim-btn" onClick={p.onSettings} title="Settings (⌘,)" aria-label="Settings">
          <svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="2.6" /><path d="M10 2.5v2.2M10 15.3v2.2M2.5 10h2.2M15.3 10h2.2M4.7 4.7l1.6 1.6M13.7 13.7l1.6 1.6M4.7 15.3l1.6-1.6M13.7 6.3l1.6-1.6" /></svg>
        </button>
        <button className="slim-btn rail-unfold" onClick={() => p.onFold(false)} title="Keep the sidebar open (⇧⌘\)" aria-label="Keep the sidebar open">
          <svg viewBox="0 0 20 20"><path d="m8 5 5 5-5 5" /></svg>
        </button>
      </div>
    </aside>
  );
  if (p.folded && !peek) return slim;

  return (
    <>
    {p.folded && slim}
    <aside className={`sidebar${p.folded ? " peek" : ""}`} onMouseEnter={stayPut} onMouseLeave={p.folded && !p.narrow ? leavePeek : undefined}>
      <div className="drag-region" />
      <div className="nav">
        <button className="nav-new" onClick={() => onNew()} title="New note in the inbox (⌘N)">New note</button>
        <button className={p.view === "home" ? "on" : ""} onClick={() => onView("home")} title="Today: your note, the inbox, what's left to do">Today</button>
        <button className={p.view === "inbox" ? "on" : ""} onClick={() => onView("inbox")}>
          Inbox {inboxCount > 0 && <span className="count">{inboxCount}</span>}
        </button>
        <button className={p.view === "tasks" ? "on" : ""} onClick={() => onView("tasks")}>
          Tasks {openTasks > 0 && <span className="count">{openTasks}</span>}
        </button>
        <button className={p.view === "graph" ? "on" : ""} onClick={() => onView("graph")} title="How your notes link up (⌥⌘G)">
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
                <div key={r.path} className="search-hit" onClick={() => onOpen(r.path)}>
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
        {p.syncLine && (
          <button className={`sync-state${p.syncError ? " bad" : ""}`} onClick={p.onSyncNow} title={p.syncError ?? "Sync now"}>
            {p.syncLine}
          </button>
        )}
        <button className="rail-fold" onClick={() => p.onFold(!p.folded)} title={p.folded ? "Keep the sidebar open (⇧⌘\\)" : "Fold the sidebar away (⇧⌘\\)"}>
          {p.folded ? "Keep open" : "Fold away"}
        </button>
      </div>
    </aside>
    </>
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
