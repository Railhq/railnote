import { useCallback, useEffect, useRef, useState } from "react";
import type { NoteFile, Settings, SyncStatus } from "../shared/types";
import { setLinkResolver } from "./editor/live-preview";
import type { OpenWhere } from "./editor/hooks";
import { plugins } from "./plugins/host";
import { PluginEntry, syncPlugins } from "./plugins/loader";
import { extOf, noteFolder } from "./lib/vault-index";
import { folderLines, lineColour } from "./lib/lines";
import { closeTab, cycle, emptyLayout, Layout, moveTab, place, retarget, unsplit } from "./lib/layout";
import { host, Workspace } from "./workspace";
import { Palette, PaletteItem } from "./components/Palette";
import { EntryKind, MainView, Sidebar } from "./components/Sidebar";
import { AskSheet } from "./components/AskSheet";
import { HistorySheet } from "./components/HistorySheet";
import { carryPosition } from "./editor/Editor";
import { HomeView, InboxView, OrganizeDialog, TasksView } from "./components/Views";
import { SettingsDialog, Welcome, syncLine } from "./components/Screens";
import { SourceView } from "./components/SourceView";
import { NotePane, PaneHandle } from "./components/NotePane";
import { GraphView } from "./components/GraphView";
import { exportNote, type ExportKind } from "./export/export";
import { keys } from "../shared/keys";

type Overlay = null | "switcher" | "commands" | "templates" | "settings" | { organize: string } | { history: string };

const mod = (e: KeyboardEvent) => e.metaKey || e.ctrlKey;
const TAB_DRAG = "application/x-railnote-tab";
const layoutKey = (vault: string) => `railnote:tabs:${vault}`;

function savedLayout(vault: string): Layout | null {
  try {
    const l = JSON.parse(localStorage.getItem(layoutKey(vault)) ?? "null") as Layout | null;
    return l && Array.isArray(l.panes) && l.panes.length ? l : null;
  } catch {
    return null;
  }
}

const NARROW = "(max-width: 700px)";

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [ws, setWs] = useState<Workspace | null>(null);
  const [, setTick] = useState(0);
  const [layout, setLayoutState] = useState<Layout>(emptyLayout);
  const [view, setView] = useState<MainView>("note");
  const [asking, setAsking] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [booting, setBooting] = useState(true);
  const [searchKey, setSearchKey] = useState(0);
  // The sidebar starts folded so the page has the window; whichever way it's left is remembered.
  const [folded, setFolded] = useState(() => { try { return localStorage.getItem("railnote:sidebar") !== "open"; } catch { return true; } });
  // A phone-sized window always has the rail, as a bar along the bottom.
  const [narrow, setNarrow] = useState(() => matchMedia(NARROW).matches);
  useEffect(() => {
    const m = matchMedia(NARROW);
    const on = () => setNarrow(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  const foldedRef = useRef(folded);
  foldedRef.current = folded;
  const fold = (f: boolean) => { setFolded(f); try { localStorage.setItem("railnote:sidebar", f ? "folded" : "open"); } catch { /* per-viewer nicety only */ } };
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [pluginList, setPluginList] = useState<PluginEntry[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [goto, setGoto] = useState<{ pane: number; path: string; line: number; key: number } | null>(null);
  const [dropPane, setDropPane] = useState<number | null>(null);
  const [draggingTab, setDraggingTab] = useState(false);

  const handles = useRef<(PaneHandle | null)[]>([]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const current = layout.panes[layout.focus]?.active ?? null;
  const currentRef = useRef(current);
  currentRef.current = current;
  const vaultRef = useRef("");

  const setLayout = (l: Layout) => {
    layoutRef.current = l;
    setLayoutState(l);
    try {
      if (vaultRef.current) localStorage.setItem(layoutKey(vaultRef.current), JSON.stringify(l));
    } catch {
      /* tabs just won't come back next time */
    }
  };

  const openVault = useCallback(async (files: NoteFile[]) => {
    const s = await host.getSettings();
    const w = new Workspace(s);
    w.index.load(files);
    w.index.setListing(await host.listFiles());
    vaultRef.current = s.vaultPath ?? "";
    setSettings(s);
    setWs(w);
    setView("note");
    // Tabs from last time, as long as their notes are still there.
    const saved = savedLayout(vaultRef.current);
    const restored = saved && retarget(saved, (p) => (w.index.notes.has(p) ? p : null));
    // Coming back to a vault starts at Today, with the route from last time waiting behind it.
    if (restored && restored.panes[0].tabs.length) return (setLayout(restored), setView("home"));
    const start = w.index.notes.has("Welcome.md") ? "Welcome.md" : w.index.all().sort((a, b) => b.mtime - a.mtime)[0]?.path ?? null;
    setLayout(start ? place(emptyLayout(), start, "here") : emptyLayout());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    (async () => {
      const s = await host.getSettings();
      setSettings(s);
      if (s.vaultPath) {
        try {
          await openVault(await host.openVault(s.vaultPath));
        } catch {
          /* the folder moved or vanished: fall through to the welcome screen */
        }
      }
      setBooting(false);
    })();
  }, [openVault]);

  /** Saves every open note's pending edits. */
  const flush = useCallback(async () => {
    await Promise.all(handles.current.map((h) => h?.flush()));
  }, []);
  const flushRef = useRef(flush);
  flushRef.current = flush;

  const open = useCallback(
    async (path: string, line?: number, where: OpenWhere = "here") => {
      if (!ws) return;
      await flush();
      const next = place(layoutRef.current, path, where);
      setLayout(next);
      setView("note");
      if (line != null) setGoto({ pane: next.focus, path, line, key: Date.now() });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws, flush],
  );

  const openLink = useCallback(
    async (target: string, where: OpenWhere = "here") => {
      if (!ws) return;
      const [name, heading] = target.split("#");
      // [[report.pdf]] and other attachments open in their own app, never as a new note.
      const ext = extOf(name);
      if (ext && ext !== "md") {
        const p = ws.index.resolveFile(name, noteFolder(currentRef.current ?? ""));
        if (!p) return setNotice(`Couldn't find ${name} in this vault.`);
        return host.openInSystem(p).catch((e) => setNotice((e as Error).message));
      }
      const p = await ws.resolveOrCreate(name || ws.index.notes.get(currentRef.current ?? "")?.name || "");
      const h = heading ? ws.index.notes.get(p)?.parsed.headings.find((x) => x.text.toLowerCase() === heading.trim().toLowerCase()) : undefined;
      open(p, h?.line, where);
    },
    [ws, open],
  );

  const close = async (pane: number, path: string) => {
    await handles.current[pane]?.flush();
    setLayout(closeTab(layoutRef.current, pane, path));
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  /** Saves open edits first, so the export has what's on screen. */
  const exportCurrent = async (path: string, kind: ExportKind) => {
    await flush();
    try {
      if (await exportNote(ws!, path, kind)) setNotice(`Exported ${ws!.index.notes.get(path)?.name ?? path} to ${kind.toUpperCase()}.`);
    } catch (e) {
      setNotice(`Couldn't export: ${(e as Error).message}`);
    }
  };
  const exportRef = useRef(exportCurrent);
  exportRef.current = exportCurrent;

  // Keep the index in step with the disk; open notes notice changes themselves.
  useEffect(() => {
    if (!ws) return;
    setLinkResolver((t) => !!ws.index.resolve(t.split("#")[0]));
    // An explainer's src: is tried as written, next to the note, as a note link, then by file name anywhere.
    const resolveSource = async (src: string) => {
      const folder = noteFolder(currentRef.current ?? "");
      const tries = [src, folder ? `${folder}/${src}` : src, ws.index.resolve(src)].filter((x): x is string => !!x);
      for (const p of [...new Set(tries)]) {
        try {
          await host.readRaw(p);
          return p;
        } catch {
          /* try the next location */
        }
      }
      const found = src.includes("/") ? null : await host.findByName(src);
      if (found) return found;
      throw new Error(`Couldn't find ${src} in this vault`);
    };
    plugins.setBridge({
      resolve: resolveSource,
      read: (p) => host.readRaw(p),
      write: (p, c) => host.write(p, c),
      notes: () => ws.index.all().map((n) => n.path),
      activeNote: () => currentRef.current,
      open: (p) => open(p),
      openFile: async (p) => {
        await flushRef.current();
        setSourcePath(p);
        setView("source");
      },
      insertText: (t, c) => handles.current[layoutRef.current.focus]?.insertText(t, c),
      notice: (m) => setNotice(m),
    });
    const offIndex = ws.index.subscribe(() => setTick((t) => t + 1));
    void host.syncStatus().then(setSync);
    const offSync = host.onSyncEvent(({ status, conflicts }) => {
      setSync(status);
      if (conflicts?.length)
        setNotice(conflicts.length === 1 ? `Another device changed a note you changed too. Its text is in ${conflicts[0].split("/").pop()}, beside yours.` : `Another device changed ${conflicts.length} files you changed too. Its versions are beside yours, marked "conflict".`);
    });
    const offVault = host.onVaultEvent((e) => {
      if (e.type === "upsert") ws.index.upsert(e.file);
      else if (e.type === "file") ws.index.setFile(e.path, e.exists);
      else if (e.type === "folder") ws.index.setFolder(e.path, e.exists);
      else {
        ws.index.remove(e.path);
        setLayout(retarget(layoutRef.current, (p) => (p === e.path ? null : p)));
      }
    });
    const offMenu = host.onMenuCommand((cmd) => {
      const l = layoutRef.current;
      const p = l.panes[l.focus]?.active;
      if (cmd === "close-tab" && p) void closeRef.current(l.focus, p);
      if (cmd === "history" && p) void showHistoryRef.current(p);
      if ((cmd === "export-html" || cmd === "export-pdf") && p) void exportRef.current(p, cmd === "export-html" ? "html" : "pdf");
    });
    return () => {
      offIndex();
      offVault();
      offSync();
      offMenu();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws]);

  // Plugins follow the open vault: its own plugins come and go with it.
  useEffect(() => {
    if (!ws) return;
    let live = true;
    host
      .listVaultPlugins()
      .then((found) => syncPlugins(ws.settings, found))
      .then((list) => live && setPluginList(list));
    return () => {
      live = false;
    };
  }, [ws]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(t);
  }, [notice]);

  const newNote = async (folder?: string) => {
    if (!ws) return;
    await flush();
    open(await ws.createNote(folder ?? ws.settings.inboxFolder, "Untitled", ""));
  };
  const daily = async () => {
    if (!ws) return;
    await flush();
    open(await ws.daily());
  };
  const remove = async (p: string, kind: EntryKind = "note") => {
    if (!ws) return;
    await flush();
    await host.remove(p);
    if (kind === "note") ws.index.remove(p);
    else if (kind === "file") ws.index.setFile(p, false);
    else {
      for (const n of ws.index.all()) if (n.path.startsWith(p + "/")) ws.index.remove(n.path);
      for (const f of [...ws.index.files.keys()]) if (f.startsWith(p + "/")) ws.index.setFile(f, false);
      for (const d of [...ws.index.dirs]) if (d === p || d.startsWith(p + "/")) ws.index.setFolder(d, false);
    }
    setLayout(retarget(layoutRef.current, (x) => (x === p || x.startsWith(p + "/") ? null : x)));
  };
  /** Sidebar renames and moves. Notes and folders keep their [[links]] working, and open tabs follow. */
  const moveEntry = async (kind: EntryKind, from: string, to: string) => {
    if (!ws) return;
    await flush();
    if (kind === "note") {
      const dst = await ws.rename(from, to);
      setLayout(retarget(layoutRef.current, (x) => (x === from ? dst : x)));
    } else if (kind === "file") await ws.moveFile(from, to);
    else {
      const moved = await ws.moveFolder(from, to);
      setLayout(retarget(layoutRef.current, (x) => moved.get(x) ?? x));
    }
  };
  const openFile = (p: string) => void host.openInSystem(p).catch((e) => setNotice((e as Error).message));
  const renameNote = async (path: string, name: string) => {
    if (!ws) return;
    const n = ws.index.notes.get(path);
    if (!n || !name.trim() || name.trim() === n.name) return;
    await flush();
    try {
      const to = ws.uniquePath(n.folder, name.trim());
      carryPosition(path, to);
      await ws.rename(path, to);
      setLayout(retarget(layoutRef.current, (x) => (x === path ? to : x)));
    } catch (e) {
      setNotice((e as Error).message);
    }
  };
  const organize = async (p: string) => {
    await flush();
    setOverlay({ organize: p });
  };
  // Pending edits are saved first, so the newest version is what's on the page.
  const showHistory = async (p: string) => {
    await flush();
    setOverlay({ history: p });
  };
  const showHistoryRef = useRef(showHistory);
  showHistoryRef.current = showHistory;
  const insertText = (text: string, cursor?: number) => handles.current[layoutRef.current.focus]?.insertText(text, cursor);
  const focusPane = (i: number) => {
    const l = layoutRef.current;
    if (l.focus !== i && l.panes[i]) setLayout({ ...l, focus: i });
  };
  const toggleSplit = async () => {
    await flush();
    const l = layoutRef.current;
    if (l.panes.length > 1) setLayout(unsplit(l));
    else if (currentRef.current) setLayout(place(l, currentRef.current, "split"));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!ws || !mod(e)) return;
      const k = e.key.toLowerCase();
      const l = layoutRef.current;
      const act: Record<string, () => void> = {
        k: () => setOverlay("switcher"),
        o: () => setOverlay("switcher"),
        p: () => setOverlay("commands"),
        n: () => newNote(),
        d: daily,
        t: () => setOverlay("templates"),
        j: () => setAsking((a) => !a),
        ",": () => setOverlay("settings"),
        "\\": () => void toggleSplit(),
      };
      if (e.shiftKey && k === "o" && current) act.o = () => organize(current);
      if (e.shiftKey && e.code === "Backslash") act[k] = () => fold(!foldedRef.current);
      if (e.shiftKey && k === "f") act.f = () => setSearchKey((n) => n + 1);
      // Ctrl+Tab and Ctrl+Shift+Tab step through tabs; Cmd+1…9 picks one; Cmd+Alt+arrows switch panes.
      if (e.ctrlKey && k === "tab") act.tab = () => setLayout(cycle(l, e.shiftKey ? -1 : 1));
      if (/^[1-9]$/.test(k) && !e.altKey) {
        const tabs = l.panes[l.focus].tabs;
        const t = k === "9" ? tabs[tabs.length - 1] : tabs[Number(k) - 1];
        if (t) act[k] = () => void open(t);
      }
      if (e.altKey && e.code === "KeyG") act[k] = () => setView((v) => (v === "graph" ? "note" : "graph"));
      if (e.altKey && (k === "arrowleft" || k === "arrowright")) act[k] = () => focusPane(k === "arrowleft" ? 0 : 1);
      if (!act[k]) return;
      e.preventDefault();
      act[k]();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (booting) return <div className="welcome" />;
  if (!ws || !settings) return <Welcome settings={settings ?? { recentVaults: [], model: "", dailyFolder: "", inboxFolder: "", templatesFolder: "" }} onOpened={(_d, files) => openVault(files)} />;

  const note = current ? ws.index.notes.get(current) : undefined;
  const lines = folderLines(ws.index);

  const switcherItems = (q: string): PaletteItem[] => {
    const hits = ws.index.quickFind(q, 30).map((n) => ({ id: n.path, label: n.name, hint: n.folder, run: () => open(n.path) }));
    if (q.trim() && !hits.some((h) => h.label.toLowerCase() === q.trim().toLowerCase()))
      hits.push({ id: "+new", label: `Create “${q.trim()}”`, hint: ws.settings.inboxFolder, run: async () => open(await ws.createNote(ws.settings.inboxFolder, q.trim(), `# ${q.trim()}\n\n`)) });
    return hits;
  };
  const commands: PaletteItem[] = [
    ...(current
      ? [
          { id: "export-html", label: "Export to HTML", run: () => void exportCurrent(current, "html") },
          { id: "export-pdf", label: "Export to PDF", hint: "⌥⌘P", run: () => void exportCurrent(current, "pdf") },
        ]
      : []),
    { id: "new", label: "New note", hint: "⌘N", run: () => newNote() },
    { id: "daily", label: "Open today's note", hint: "⌘D", run: daily },
    { id: "switch", label: "Open note…", hint: "⌘K", run: () => setOverlay("switcher") },
    { id: "search", label: "Search all notes", hint: "⇧⌘F", run: () => setSearchKey((n) => n + 1) },
    { id: "fold", label: folded ? "Keep the sidebar open" : "Fold the sidebar away", hint: "⇧⌘\\", run: () => fold(!folded) },
    { id: "inbox", label: "Show inbox", run: () => setView("inbox") },
    { id: "tasks", label: "Show all tasks", run: () => setView("tasks") },
    { id: "graph", label: "Show graph view", hint: "⌥⌘G", run: () => setView("graph") },
    { id: "ask", label: "Ask your notes", hint: "⌘J", run: () => setAsking(true) },
    ...(current ? [{ id: "history", label: "Show version history", hint: "⇧⌘H", run: () => void showHistory(current) }] : []),
    ...(current ? [{ id: "org", label: "Organize this note with Claude", hint: "⇧⌘O", run: () => organize(current) }] : []),
    { id: "split", label: layout.panes.length > 1 ? "Close split view" : "Open this note to the side", hint: "⌘\\", run: () => void toggleSplit() },
    ...(current ? [{ id: "close-tab", label: "Close tab", hint: "⌘W", run: () => void close(layout.focus, current) }] : []),
    { id: "tpl", label: "Insert template…", hint: "⌘T", run: () => setOverlay("templates") },
    { id: "settings", label: "Settings", hint: "⌘,", run: () => setOverlay("settings") },
    {
      id: "agent-skills",
      label: "Teach agents to edit explainers",
      run: () =>
        void host
          .installAgentSkills()
          .then((w) => setNotice(w.length ? "Claude Code and other agents in this vault can now edit explainers: see .claude/skills/railnote-explainers." : "No agent skills in this build."))
          .catch((e) => setNotice(`Couldn't add the skill: ${(e as Error).message}`)),
    },
    ...plugins.commands,
  ];

  const split = layout.panes.length > 1;
  const dropTab = (e: React.DragEvent, pane: number, before?: string) => {
    const raw = e.dataTransfer.getData(TAB_DRAG);
    if (!raw) return;
    e.preventDefault();
    e.stopPropagation();
    setDropPane(null);
    const { pane: from, path } = JSON.parse(raw) as { pane: number; path: string };
    void flush().then(() => setLayout(moveTab(layoutRef.current, from, path, pane, before)));
  };
  const acceptTab = (e: React.DragEvent, pane: number) => {
    if (!e.dataTransfer.types.includes(TAB_DRAG)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dropPane !== pane) setDropPane(pane);
  };

  return (
    <div className={`app${folded || narrow ? " folded" : ""}${narrow ? " narrow" : ""}`}>
      <Sidebar folded={folded || narrow} narrow={narrow} onFold={fold} ws={ws} current={current} view={view} onOpen={(p, where) => open(p, undefined, where)} onView={setView} onNew={newNote} onDaily={daily} onSettings={() => setOverlay("settings")} syncLine={syncLine(sync)} syncError={sync?.state === "error" ? sync.error : undefined} onSyncNow={() => void host.syncNow()} onDelete={remove} onMove={moveEntry} onOpenFile={openFile} searchKey={searchKey} />
      <main className="main">
        {view !== "note" && <div className="drag-region" />}
        {view === "home" && <HomeView ws={ws} route={layout.panes[layout.focus].tabs.filter((t) => ws.index.notes.has(t))} here={layout.panes[layout.focus].active} onDaily={daily} onOpen={(p, line) => void open(p, line)} onOrganize={organize} onView={setView} />}
        {view === "tasks" && <TasksView ws={ws} onOpen={open} />}
        {view === "graph" && <GraphView ws={ws} current={current} onOpen={(p, where) => void open(p, undefined, where)} />}
        {view === "inbox" && <InboxView ws={ws} onOpen={(p) => open(p)} onOrganize={organize} onNew={() => newNote()} />}
        {view === "note" && (
          <div className={`panes${split ? " split" : ""}`}>
            {layout.panes.map((pn, i) => {
              const shown = pn.active && ws.index.notes.has(pn.active) ? pn.active : null;
              return (
                <section key={i} className={`pane${split && i === layout.focus ? " focused" : ""}${dropPane === i ? " drop" : ""}`} onDragOver={(e) => acceptTab(e, i)} onDragLeave={() => setDropPane(null)} onDrop={(e) => dropTab(e, i)}>
                  <div className="tabbar route" role="tablist" aria-label="Route">
                    {pn.tabs.map((t, k) => (
                      <div
                        key={t}
                        role="tab"
                        aria-selected={t === pn.active}
                        className={`tab stop${t === pn.active ? " active" : ""}`}
                        style={{ "--track": k ? lineColour(lines, t) : "transparent", "--next": k < pn.tabs.length - 1 ? lineColour(lines, pn.tabs[k + 1]) : "transparent" } as React.CSSProperties}
                        title={t}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData(TAB_DRAG, JSON.stringify({ pane: i, path: t }));
                          setDraggingTab(true);
                        }}
                        onDragEnd={() => {
                          setDraggingTab(false);
                          setDropPane(null);
                        }}
                        onDrop={(e) => dropTab(e, i, t)}
                        onClick={() => {
                          focusPane(i);
                          if (t !== pn.active) void flush().then(() => setLayout({ ...place({ ...layoutRef.current, focus: i }, t, "here") }));
                        }}
                        onAuxClick={(e) => e.button === 1 && void close(i, t)}
                      >
                        <span className="stop-dot" aria-hidden="true" />
                        <span className="tab-name">{ws.index.notes.get(t)?.name ?? t.replace(/^.*\//, "").replace(/\.md$/, "")}</span>
                        <button
                          className="tab-x"
                          aria-label={`Close ${t}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            void close(i, t);
                          }}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    {!split && i === 0 && current && (
                      <button className="tab-split" title={keys("Open this note to the side (⌘\\)")} aria-label="Split view" onClick={() => void toggleSplit()}>
                        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" /><path d="M8 2.5v11" stroke="currentColor" /></svg>
                      </button>
                    )}
                  </div>
                  {shown ? (
                    <NotePane
                      key={shown}
                      ref={(h) => (handles.current[i] = h)}
                      ws={ws}
                      path={shown}
                      goto={goto && goto.pane === i && goto.path === shown ? goto : undefined}
                      focused={i === layout.focus}
                      onFocus={() => focusPane(i)}
                      onOpenLink={(t, where) => {
                        focusPane(i);
                        void openLink(t, where);
                      }}
                      onOpen={(path, where) => {
                        focusPane(i);
                        void open(path, undefined, where);
                      }}
                      onOrganize={organize}
                      onHistory={(path) => void showHistory(path)}
                      onRename={renameNote}
                      onNotice={setNotice}
                    />
                  ) : (
                    <div className="empty-main">
                      <p>No note open.</p>
                      <button onClick={() => newNote()}>New note</button> <button onClick={daily}>Today's note</button>
                      <p className="muted small">{keys("Press ⌘K to jump to any note, or ⌘P for every command.")}</p>
                    </div>
                  )}
                </section>
              );
            })}
            {/* Dragging a tab to the right edge opens it to the side. */}
            {!split && draggingTab && layout.panes[0].tabs.length > 1 && (
              <div className={`split-target${dropPane === 1 ? " drop" : ""}`} onDragOver={(e) => acceptTab(e, 1)} onDragLeave={() => setDropPane(null)} onDrop={(e) => dropTab(e, 1)} aria-hidden="true" />
            )}
          </div>
        )}
        {view === "source" && sourcePath && <SourceView key={sourcePath} path={sourcePath} backLabel={note?.name ?? "note"} onBack={() => setView("note")} />}
        <AskSheet ws={ws} open={asking} onClose={() => setAsking(false)} onOpen={(p) => void open(p)} onOpenLink={(t) => void openLink(t)} />
      </main>

      {overlay === "switcher" && <Palette placeholder="Jump to a note, or type a new name" items={switcherItems} onClose={() => setOverlay(null)} />}
      {overlay === "commands" && (
        <Palette placeholder="Run a command" items={(q) => commands.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()))} onClose={() => setOverlay(null)} />
      )}
      {overlay === "templates" && (
        <Palette
          placeholder={ws.templates().length ? "Insert a template" : `Add notes to ${ws.settings.templatesFolder}/ to use them here`}
          items={(q) =>
            ws.templates()
              .filter((n) => n.name.toLowerCase().includes(q.toLowerCase()))
              .map((n) => ({ id: n.path, label: n.name, run: () => insertText(ws.fillTemplate(n.content)) }))
          }
          onClose={() => setOverlay(null)}
        />
      )}
      {notice && <div className="notice" role="status">{notice}</div>}
      {overlay === "settings" && (
        <SettingsDialog
          settings={settings}
          plugins={pluginList}
          onClose={() => setOverlay(null)}
          onSaved={(s) => {
            setSettings(s);
            ws.settings = s;
          }}
          onPluginsChanged={async (s) => {
            setSettings(s);
            ws.settings = s;
            setPluginList(await syncPlugins(s, await host.listVaultPlugins()));
          }}
          onSwitchVault={async () => {
            const dir = await host.chooseVault();
            if (!dir) return;
            await flush();
            setOverlay(null);
            openVault(await host.openVault(dir));
          }}
        />
      )}
      {overlay && typeof overlay === "object" && "history" in overlay && (
        <HistorySheet
          ws={ws}
          path={overlay.history}
          onClose={() => setOverlay(null)}
          onNotice={setNotice}
          onRestored={(text, v) => {
            ws.index.upsert({ path: overlay.history, content: text, mtime: Date.now() });
            setOverlay(null);
            setNotice(`Restored the version from ${new Date(v.time).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}. The text it replaced is in the history too.`);
          }}
        />
      )}
      {overlay && typeof overlay === "object" && "organize" in overlay && (
        <OrganizeDialog
          ws={ws}
          path={overlay.organize}
          onClose={() => setOverlay(null)}
          onDone={(p) => {
            const from = overlay.organize;
            setOverlay(null);
            setLayout(retarget(layoutRef.current, (x) => (x === from ? p : x)));
          }}
        />
      )}
    </div>
  );
}
