import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import type { NoteFile, Settings } from "../shared/types";
import { Editor } from "./editor/Editor";
import { setLinkResolver } from "./editor/live-preview";
import { plugins } from "./plugins/host";
import { PluginEntry, syncPlugins } from "./plugins/loader";
import { extOf, fileName, isMedia, noteFolder } from "./lib/vault-index";
import { host, Workspace } from "./workspace";
import { Palette, PaletteItem } from "./components/Palette";
import { EntryKind, MainView, Sidebar } from "./components/Sidebar";
import { RightPanel } from "./components/RightPanel";
import { InboxView, OrganizeDialog, TasksView } from "./components/Views";
import { SettingsDialog, Welcome } from "./components/Screens";
import { SourceView } from "./components/SourceView";

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
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [pluginList, setPluginList] = useState<PluginEntry[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const insertRef = useRef<(text: string, cursor?: number) => void>(() => {});

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
    w.index.setListing(await host.listFiles());
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
  const flushRef = useRef(flush);
  flushRef.current = flush;

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
      // [[report.pdf]] and other attachments open in their own app, never as a new note.
      const ext = extOf(name);
      if (ext && ext !== "md") {
        const p = ws.index.resolveFile(name, noteFolder(currentRef.current ?? ""));
        if (!p) return setNotice(`Couldn't find ${name} in this vault.`);
        return host.openInSystem(p).catch((e) => setNotice((e as Error).message));
      }
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
      insertText: (t, c) => insertRef.current(t, c),
      notice: (m) => setNotice(m),
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
      else if (e.type === "file") ws.index.setFile(e.path, e.exists);
      else if (e.type === "folder") ws.index.setFolder(e.path, e.exists);
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

  const newNote = async (folder?: string) => {
    if (!ws) return;
    await flush();
    const p = await ws.createNote(folder ?? ws.settings.inboxFolder, "Untitled", "");
    loadNote(ws, p);
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
    const cur = currentRef.current;
    if (kind === "note") ws.index.remove(p);
    else if (kind === "file") ws.index.setFile(p, false);
    else {
      for (const n of ws.index.all()) if (n.path.startsWith(p + "/")) ws.index.remove(n.path);
      for (const f of [...ws.index.files.keys()]) if (f.startsWith(p + "/")) ws.index.setFile(f, false);
      for (const d of [...ws.index.dirs]) if (d === p || d.startsWith(p + "/")) ws.index.setFolder(d, false);
    }
    if (cur && (cur === p || cur.startsWith(p + "/"))) loadNote(ws, null);
  };
  /** Sidebar renames and moves. Notes and folders keep their [[links]] working. */
  const moveEntry = async (kind: EntryKind, from: string, to: string) => {
    if (!ws) return;
    await flush();
    const cur = currentRef.current;
    if (kind === "note") {
      const dst = await ws.rename(from, to);
      if (cur === from) loadNote(ws, dst);
    } else if (kind === "file") await ws.moveFile(from, to);
    else {
      const moved = await ws.moveFolder(from, to);
      if (cur && moved.has(cur)) loadNote(ws, moved.get(cur)!);
    }
  };
  const openFile = (p: string) => void host.openInSystem(p).catch((e) => setNotice((e as Error).message));
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
  /** Pasted or dropped files are saved into the attachments folder and embedded where they landed. */
  const addFiles = async (files: File[], pos: number) => {
    if (!ws || !current) return;
    const setting = (ws.settings.attachmentsFolder ?? "Attachments").replace(/\/+$/, "");
    const folder = setting === "." || setting === "./" || setting.startsWith("./") ? [noteFolder(current), setting.slice(2)].filter(Boolean).join("/") : setting;
    const d = new Date();
    const stamp = [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join("");
    const refs: string[] = [];
    for (const f of files) {
      const ext = extOf(f.name) || (f.type.split("/")[1] ?? "bin");
      // Screenshots arrive as "image.png"; name them the way Obsidian does.
      const name = !f.name || /^image\.\w+$/.test(f.name) ? `Pasted image ${stamp}.${ext}` : f.name;
      try {
        const path = await host.saveAttachment(folder, name, new Uint8Array(await f.arrayBuffer()));
        ws.index.setFile(path, true);
        const ref = ws.index.resolveFile(fileName(path)) === path ? fileName(path) : path;
        refs.push(isMedia(extOf(path)) ? `![[${ref}]]` : `[[${ref}]]`);
      } catch (e) {
        setNotice(`Couldn't save ${f.name}: ${(e as Error).message}`);
      }
    }
    const v = editorView.current;
    if (!v || !refs.length) return;
    const line = v.state.doc.lineAt(pos);
    // Embeds draw as blocks only on a line of their own.
    const before = pos > line.from && line.text.slice(0, pos - line.from).trim() ? "\n" : "";
    const after = pos < line.to ? "\n" : "";
    const text = before + refs.join("\n") + after;
    v.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length } });
    v.focus();
  };

  const insertText = (text: string, cursor = text.length) => {
    const v = editorView.current;
    if (!v) return;
    const { from, to } = v.state.selection.main;
    v.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + cursor } });
    v.focus();
  };
  insertRef.current = insertText;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!ws || !mod(e)) return;
      const k = e.key.toLowerCase();
      const act: Record<string, () => void> = {
        k: () => setOverlay("switcher"),
        o: () => setOverlay("switcher"),
        p: () => setOverlay("commands"),
        n: () => newNote(),
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
    { id: "new", label: "New note", hint: "⌘N", run: () => newNote() },
    { id: "daily", label: "Open today's note", hint: "⌘D", run: daily },
    { id: "switch", label: "Open note…", hint: "⌘K", run: () => setOverlay("switcher") },
    { id: "search", label: "Search all notes", hint: "⇧⌘F", run: () => setSearchKey((n) => n + 1) },
    { id: "inbox", label: "Show inbox", run: () => setView("inbox") },
    { id: "tasks", label: "Show all tasks", run: () => setView("tasks") },
    { id: "ask", label: "Ask your notes", hint: "⌘J", run: () => setRightTab("ask") },
    ...(current ? [{ id: "org", label: "Organize this note with Claude", hint: "⇧⌘O", run: () => organize(current) }] : []),
    { id: "tpl", label: "Insert template…", hint: "⌘T", run: () => setOverlay("templates") },
    { id: "settings", label: "Settings", hint: "⌘,", run: () => setOverlay("settings") },
    ...plugins.commands,
  ];

  return (
    <div className="app">
      <Sidebar ws={ws} current={current} view={view} onOpen={(p) => open(p)} onView={setView} onNew={newNote} onDaily={daily} onSettings={() => setOverlay("settings")} onDelete={remove} onMove={moveEntry} onOpenFile={openFile} searchKey={searchKey} />
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
              hooks={{
                resolveFile: (src) => {
                  const p = ws.index.resolveFile(src, noteFolder(current));
                  return p ? { path: p, version: ws.index.files.get(p) ?? 0 } : null;
                },
                resolveNote: (t) => ws.index.resolve(t),
                noteContent: (p) => ws.index.notes.get(p)?.content ?? null,
                openInSystem: (p) => void host.openInSystem(p).catch((e) => setNotice((e as Error).message)),
              }}
              onFiles={addFiles}
              onView={(v) => {
                editorView.current = v;
                if (v && pendingLine.current != null) gotoLine(pendingLine.current);
              }}
            />
          </>
        )}
        {view === "source" && sourcePath && (
          <SourceView key={sourcePath} path={sourcePath} backLabel={note?.name ?? "note"} onBack={() => loadNote(ws, currentRef.current)} />
        )}
        {view === "note" && !note && (
          <div className="empty-main">
            <p>No note open.</p>
            <button onClick={() => newNote()}>New note</button> <button onClick={daily}>Today's note</button>
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
