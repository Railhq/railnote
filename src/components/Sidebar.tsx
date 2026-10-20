import { useEffect, useMemo, useState } from "react";
import type { Note } from "../lib/vault-index";
import type { Workspace } from "../workspace";

export type MainView = "note" | "tasks" | "inbox" | "source";

interface Props {
  ws: Workspace;
  current: string | null;
  view: MainView;
  onOpen(path: string): void;
  onView(v: MainView): void;
  onNew(): void;
  onDaily(): void;
  onSettings(): void;
  onDelete(path: string): void;
  /** Bumped by Cmd+Shift+F to switch to the search tab. */
  searchKey: number;
}

interface Tree {
  folders: Map<string, Tree>;
  notes: Note[];
}

function buildTree(notes: Note[], folders: string[]): Tree {
  const root: Tree = { folders: new Map(), notes: [] };
  const at = (folder: string) => {
    let node = root;
    if (folder) for (const part of folder.split("/")) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), notes: [] });
      node = node.folders.get(part)!;
    }
    return node;
  };
  folders.forEach(at);
  for (const n of notes) at(n.folder).notes.push(n);
  return root;
}

export function Sidebar(p: Props) {
  const [tab, setTab] = useState<"files" | "search" | "tags">("files");
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const idx = p.ws.index;
  useEffect(() => {
    if (p.searchKey) setTab("search");
  }, [p.searchKey]);
  const inboxCount = idx.all().filter((n) => n.folder === p.ws.settings.inboxFolder).length;
  const openTasks = useMemo(() => idx.all().reduce((a, n) => a + n.parsed.tasks.filter((t) => !t.done).length, 0), [idx.version]);
  const tree = useMemo(() => buildTree(idx.all(), idx.folders()), [idx.version]);
  const results = useMemo(() => idx.searchText(query, 60), [query, idx.version]);

  const toggle = (k: string) => setClosed((s) => {
    const n = new Set(s);
    n.has(k) ? n.delete(k) : n.add(k);
    return n;
  });

  // The tree is drawn as a line map: each folder is a line, each note a stop on it.
  const stopX = (depth: number) => 20 + Math.max(depth - 1, 0) * 14;
  const renderTree = (t: Tree, prefix: string, depth: number, line = "var(--line-0)"): JSX.Element[] => {
    const out: JSX.Element[] = [];
    const sorted = t.notes.sort((a, b) => a.name.localeCompare(b.name));
    sorted.forEach((n, i) => {
      out.push(
        <div
          key={n.path}
          className={`tree-note${n.path === p.current && p.view === "note" ? " active" : ""}${i === sorted.length - 1 ? " last" : ""}`}
          style={{ "--x": `${stopX(depth)}px`, "--track": line } as React.CSSProperties}
          onClick={() => p.onOpen(n.path)}
          onContextMenu={(e) => {
            e.preventDefault();
            if (confirm(`Move "${n.name}" to the vault's .trash folder?`)) p.onDelete(n.path);
          }}
          title={n.path}
        >
          {n.name}
        </div>,
      );
    });
    [...t.folders].sort((a, b) => a[0].localeCompare(b[0])).forEach(([name, sub], i) => {
      const key = prefix ? `${prefix}/${name}` : name;
      const isClosed = closed.has(key);
      const color = depth === 0 ? `var(--line-${(i % 4) + 1})` : line;
      out.push(
        <div
          key={"d:" + key}
          className={`tree-folder${isClosed ? " closed" : ""}`}
          style={{ "--x": `${stopX(depth + 1)}px`, "--track": color } as React.CSSProperties}
          onClick={() => toggle(key)}
          title={isClosed ? "Show notes" : "Hide notes"}
        >
          {name}
        </div>,
      );
      if (!isClosed) out.push(...renderTree(sub, key, depth + 1, color));
    });
    return out;
  };

  return (
    <aside className="sidebar">
      <div className="drag-region" />
      <div className="nav">
        <button className="nav-new" onClick={p.onNew} title="New note in the inbox (⌘N)">New note</button>
        <button onClick={p.onDaily} title="Today's note (⌘D)">Today</button>
        <button className={p.view === "inbox" ? "on" : ""} onClick={() => p.onView("inbox")}>
          Inbox {inboxCount > 0 && <span className="count">{inboxCount}</span>}
        </button>
        <button className={p.view === "tasks" ? "on" : ""} onClick={() => p.onView("tasks")}>
          Tasks {openTasks > 0 && <span className="count">{openTasks}</span>}
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
        {tab === "files" && renderTree(tree, "", 0)}
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
      <div className="side-foot">
        <button onClick={p.onSettings}>Settings</button>
      </div>
    </aside>
  );
}
