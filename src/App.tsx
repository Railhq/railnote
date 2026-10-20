import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import type { NoteFile, Settings } from "../shared/types";
import { Editor } from "./editor/Editor";
import { setLinkResolver } from "./editor/live-preview";
import { setCanvizSourceReader } from "./editor/canviz-widget";
import { noteFolder } from "./lib/vault-index";
import { host, Workspace } from "./workspace";
import { Palette, PaletteItem } from "./components/Palette";
import { MainView, Sidebar } from "./components/Sidebar";
import { RightPanel } from "./components/RightPanel";
import { InboxView, OrganizeDialog, TasksView } from "./components/Views";
import { SettingsDialog, Welcome } from "./components/Screens";

type Overlay = null | "switcher" | "commands" | "templates" | "settings" | { organize: string };

const mod = (e: KeyboardEvent) => e.metaKey || e.ctrlKey;

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [ws, setWs] = useState<Workspace | null>(null);
  const [, setTick] = useState(0);
  const [current, setCurrent] = useState<string | null>(null);
  const [view, setView] = useState<MainView>("note");
  const [rightTab, setRightTab] = useState<"links" | "outline" | "ask">("links");
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [conflict, setConflict] = useState(false);
  const [initial, setInitial] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [booting, setBooting] = useState(true);
  const [searchKey, setSearchKey] = useState(0);

  // What the editor and the file agree on; anything else in the index for this path came from elsewhere.
  const synced = useRef("");
  const draft = useRef("");
  const timer = useRef<number>();
  const editorView = useRef<EditorView | null>(null);
  const pendingLine = useRef<number | null>(null);
  const currentRef = useRef(current);
  currentRef.current = current;

  const openVault = useCallback(async (files: NoteFile[]) => {
    const s = await host.getSettings();
    const w = new Workspace(s);
    w.index.load(files);
    setSettings(s);
    setWs(w);
    const start = w.index.notes.has("Welcome.md") ? "Welcome.md" : w.index.all().sort((a, b) => b.mtime - a.mtime)[0]?.path ?? null;
    loadNote(w, start);
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

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    const p = currentRef.current;
    if (!ws || !p || draft.current === synced.current || conflict) return;
    synced.current = draft.current;
    await ws.write(p, draft.current);
  }, [ws, conflict]);

  function loadNote(w: Workspace, path: string | null, line?: number) {
    const content = path ? w.index.notes.get(path)?.content ?? "" : "";
    synced.current = draft.current = content;
    setInitial(content);
    setConflict(false);
    setCurrent(path);
    setView("note");
    pendingLine.current = line ?? null;
    if (path && path === currentRef.current) setReloadKey((k) => k + 1);
    if (line != null) gotoLine(line);
  }

  const gotoLine = (line: number) => {
    const v = editorView.current;
    if (!v) return;
    const l = v.state.doc.line(Math.min(line + 1, v.state.doc.lines));
    v.dispatch({ selection: { anchor: l.from }, scrollIntoView: true });
    v.focus();
    pendingLine.current = null;
  };

  const open = useCallback(
    async (path: string, line?: number) => {
      if (!ws) return;
      await flush();
      if (path === currentRef.current && view === "note") {
        if (line != null) gotoLine(line);
        return;
      }
      loadNote(ws, path, line);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws, flush, view],
  );

  const openLink = useCallback(
    async (target: string) => {
      if (!ws) return;
      const [name, heading] = target.split("#");
      const p = await ws.resolveOrCreate(name || ws.index.notes.get(currentRef.current ?? "")?.name || "");
      const h = heading ? ws.index.notes.get(p)?.parsed.headings.find((x) => x.text.toLowerCase() === heading.trim().toLowerCase()) : undefined;
      open(p, h?.line);
    },
    [ws, open],
  );

  // Keep the index in step with the disk, and notice when the open note changed underneath the editor.
  useEffect(() => {
    if (!ws) return;
    setLinkResolver((t) => !!ws.index.resolve(t.split("#")[0]));
    setCanvizSourceReader(async (src) => {
      const folder = noteFolder(currentRef.current ?? "");
      const tries = [src, folder ? `${folder}/${src}` : src, ws.index.resolve(src)].filter((x): x is string => !!x);
      for (const p of [...new Set(tries)]) {
        try {
          return await host.readRaw(p);
        } catch {
          /* try the next location */
        }
      }
      const found = src.includes("/") ? null : await host.findByName(src);
      if (found) return host.readRaw(found);
      throw new Error(`Couldn't find ${src} in this vault`);
    });
    const offIndex = ws.index.subscribe(() => {
      setTick((t) => t + 1);
      const p = currentRef.current;
      if (!p) return;
      const n = ws.index.notes.get(p);
      if (!n || n.content === synced.current) return;
      if (draft.current === synced.current) {
        synced.current = draft.current = n.content;
        setInitial(n.content);
        setReloadKey((k) => k + 1);
      } else setConflict(true);
    });
    const offVault = host.onVaultEvent((e) => {
      if (e.type === "upsert") ws.index.upsert(e.file);
      else {
        ws.index.remove(e.path);
        if (e.path === currentRef.current) setCurrent(null);
      }
    });
    return () => {
      offIndex();
      offVault();
    };
  }, [ws]);

  const onChange = (content: string) => {
    draft.current = content;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 400);
  };

  useEffect(() => {
    const save = () => void flush();
    window.addEventListener("beforeunload", save);
    return () => window.removeEventListener("beforeunload", save);
  }, [flush]);

  const newNote = async () => {
    if (!ws) return;
    await flush();
    const p = await ws.createNote(ws.settings.inboxFolder, "Untitled", "");
    loadNote(ws, p);
  };
  const daily = async () => {
    if (!ws) return;
    await flush();
    open(await ws.daily());
  };
  const remove = async (p: string) => {
    if (!ws) return;
    await host.remove(p);
    ws.index.remove(p);
    if (p === currentRef.current) loadNote(ws, null);
  };
  const renameCurrent = async (name: string) => {
    if (!ws || !current) return;
    const n = ws.index.notes.get(current);
    if (!n || !name.trim() || name.trim() === n.name) return;
    await flush();
    try {
      const to = await ws.rename(current, ws.uniquePath(n.folder, name.trim()));
      loadNote(ws, to);
    } catch (e) {
      alert((e as Error).message);
    }
  };
  const organize = async (p: string) => {
    await flush();
    setOverlay({ organize: p });
  };
  const insertText = (text: string) => {
    const v = editorView.current;
    if (!v) return;
    const { from, to } = v.state.selection.main;
    v.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
    v.focus();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!ws || !mod(e)) return;
      const k = e.key.toLowerCase();
      const act: Record<string, () => void> = {
        k: () => setOverlay("switcher"),
        o: () => setOverlay("switcher"),
        p: () => setOverlay("commands"),
        n: newNote,
        d: daily,
        t: () => setOverlay("templates"),
        j: () => setRightTab("ask"),
        ",": () => setOverlay("settings"),
      };
      if (e.shiftKey && k === "o" && current) act.o = () => organize(current);
      if (e.shiftKey && k === "f") act.f = () => setSearchKey((n) => n + 1);
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

  const switcherItems = (q: string): PaletteItem[] => {
    const hits = ws.index.quickFind(q, 30).map((n) => ({ id: n.path, label: n.name, hint: n.folder, run: () => open(n.path) }));
    if (q.trim() && !hits.some((h) => h.label.toLowerCase() === q.trim().toLowerCase()))
      hits.push({ id: "+new", label: `Create “${q.trim()}”`, hint: ws.settings.inboxFolder, run: async () => open(await ws.createNote(ws.settings.inboxFolder, q.trim(), `# ${q.trim()}\n\n`)) });
    return hits;
  };
  const commands: PaletteItem[] = [
    { id: "new", label: "New note", hint: "⌘N", run: newNote },
    { id: "daily", label: "Open today's note", hint: "⌘D", run: daily },
    { id: "switch", label: "Open note…", hint: "⌘K", run: () => setOverlay("switcher") },
    { id: "search", label: "Search all notes", hint: "⇧⌘F", run: () => setSearchKey((n) => n + 1) },
    { id: "inbox", label: "Show inbox", run: () => setView("inbox") },
    { id: "tasks", label: "Show all tasks", run: () => setView("tasks") },
    { id: "ask", label: "Ask your notes", hint: "⌘J", run: () => setRightTab("ask") },
    ...(current ? [{ id: "org", label: "Organize this note with Claude", hint: "⇧⌘O", run: () => organize(current) }] : []),
    { id: "tpl", label: "Insert template…", hint: "⌘T", run: () => setOverlay("templates") },
    { id: "settings", label: "Settings", hint: "⌘,", run: () => setOverlay("settings") },
  ];

  return (
    <div className="app">
      <Sidebar ws={ws} current={current} view={view} onOpen={(p) => open(p)} onView={setView} onNew={newNote} onDaily={daily} onSettings={() => setOverlay("settings")} onDelete={remove} searchKey={searchKey} />
      <main className="main">
        <div className="drag-region" />
        {view === "tasks" && <TasksView ws={ws} onOpen={open} />}
        {view === "inbox" && <InboxView ws={ws} onOpen={(p) => open(p)} onOrganize={organize} onNew={newNote} />}
        {view === "note" && note && current && (
          <>
            <div className="note-head">
              <span className="crumb">{note.folder}</span>
              <input
                key={current}
                className="title"
                defaultValue={note.name}
                onBlur={(e) => renameCurrent(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") {
                    (e.target as HTMLInputElement).value = note.name;
                    (e.target as HTMLInputElement).blur();
                  }
                }}
              />
              <button className="ghost" title="Ask Claude where this note belongs (⇧⌘O)" onClick={() => organize(current)}>Organize</button>
            </div>
            {conflict && (
              <div className="banner">
                This note was changed outside Railnote while you were editing.
                <button
                  onClick={() => {
                    const disk = ws.index.notes.get(current)?.content ?? "";
                    synced.current = draft.current = disk;
                    setInitial(disk);
                    setReloadKey((k) => k + 1);
                    setConflict(false);
                  }}
                >
                  Load theirs
                </button>
                <button
                  onClick={async () => {
                    setConflict(false);
                    synced.current = draft.current;
                    await ws.write(current, draft.current);
                  }}
                >
                  Keep mine
                </button>
              </div>
            )}
            <Editor
              path={current}
              initial={initial}
              reloadKey={reloadKey}
              index={ws.index}
              onChange={onChange}
              onOpenLink={(t) => openLink(t)}
              onOpenUrl={(u) => host.openExternal(u)}
              onView={(v) => {
                editorView.current = v;
                if (v && pendingLine.current != null) gotoLine(pendingLine.current);
              }}
            />
          </>
        )}
        {view === "note" && !note && (
          <div className="empty-main">
            <p>No note open.</p>
            <button onClick={newNote}>New note</button> <button onClick={daily}>Today's note</button>
            <p className="muted small">Press ⌘K to jump to any note, or ⌘P for every command.</p>
          </div>
        )}
      </main>
      <RightPanel ws={ws} current={view === "note" ? current : null} tab={rightTab} onTab={setRightTab} onOpen={open} onOpenLink={openLink} />

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
      {overlay === "settings" && (
        <SettingsDialog
          settings={settings}
          onClose={() => setOverlay(null)}
          onSaved={(s) => {
            setSettings(s);
            ws.settings = s;
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
      {overlay && typeof overlay === "object" && (
        <OrganizeDialog
          ws={ws}
          path={overlay.organize}
          onClose={() => setOverlay(null)}
          onDone={(p) => {
            setOverlay(null);
            if (view === "note") loadNote(ws, p);
          }}
        />
      )}
    </div>
  );
}
