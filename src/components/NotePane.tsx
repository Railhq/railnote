import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { Editor } from "../editor/Editor";
import type { OpenWhere } from "../editor/hooks";
import { extOf, fileName, isMedia, noteFolder } from "../lib/vault-index";
import { host, type Workspace } from "../workspace";

/** What the app asks of an open note: save it now, jump to a line, type into it. */
export interface PaneHandle {
  flush(): Promise<void>;
  gotoLine(line: number): void;
  insertText(text: string, cursor?: number): void;
}

interface Props {
  ws: Workspace;
  path: string;
  /** Line to jump to once the editor is up; `key` changes for each new request. */
  goto?: { line: number; key: number };
  focused: boolean;
  onFocus(): void;
  onOpenLink(target: string, where: OpenWhere): void;
  onOrganize(path: string): void;
  onRename(from: string, name: string): void;
  onNotice(message: string): void;
}

/** One note being edited: its title, the conflict banner, and the editor, saving as you type. */
export const NotePane = forwardRef<PaneHandle, Props>(function NotePane(p, ref) {
  const { ws, path } = p;
  const note = ws.index.notes.get(path);
  const [initial, setInitial] = useState(() => note?.content ?? "");
  const [reloadKey, setReloadKey] = useState(0);
  const [conflict, setConflict] = useState(false);
  // What the editor and the file agree on; anything else in the index for this path came from elsewhere.
  const synced = useRef(initial);
  const draft = useRef(initial);
  const timer = useRef<number>();
  const view = useRef<EditorView | null>(null);
  const pendingLine = useRef<number | null>(p.goto?.line ?? null);
  const conflictRef = useRef(conflict);
  conflictRef.current = conflict;

  const flush = async () => {
    window.clearTimeout(timer.current);
    if (draft.current === synced.current || conflictRef.current || !ws.index.notes.has(path)) return;
    synced.current = draft.current;
    await ws.write(path, draft.current);
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;

  const gotoLine = (line: number) => {
    const v = view.current;
    if (!v) return void (pendingLine.current = line);
    const l = v.state.doc.line(Math.min(line + 1, v.state.doc.lines));
    v.dispatch({ selection: { anchor: l.from }, scrollIntoView: true });
    v.focus();
    pendingLine.current = null;
  };

  const insertText = (text: string, cursor = text.length) => {
    const v = view.current;
    if (!v) return;
    const { from, to } = v.state.selection.main;
    v.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + cursor } });
    v.focus();
  };

  useImperativeHandle(ref, () => ({ flush: () => flushRef.current(), gotoLine, insertText }));

  useEffect(() => {
    if (p.goto) gotoLine(p.goto.line);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.goto?.key]);

  // Saves on a pause in typing, when the tab closes, and before the window goes.
  useEffect(() => {
    const save = () => void flushRef.current();
    window.addEventListener("beforeunload", save);
    return () => {
      window.removeEventListener("beforeunload", save);
      save();
    };
  }, []);

  // Another pane, another app or a sync can change this note; take it unless there are unsaved edits.
  useEffect(
    () =>
      ws.index.subscribe(() => {
        const n = ws.index.notes.get(path);
        if (!n || n.content === synced.current) return;
        if (draft.current === synced.current) {
          synced.current = draft.current = n.content;
          setInitial(n.content);
          setReloadKey((k) => k + 1);
        } else setConflict(true);
      }),
    [ws, path],
  );

  /** Pasted or dropped files are saved into the attachments folder and embedded where they landed. */
  const addFiles = async (files: File[], pos: number) => {
    const setting = (ws.settings.attachmentsFolder ?? "Attachments").replace(/\/+$/, "");
    const folder = setting === "." || setting === "./" || setting.startsWith("./") ? [noteFolder(path), setting.slice(2)].filter(Boolean).join("/") : setting;
    const d = new Date();
    const stamp = [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join("");
    const refs: string[] = [];
    for (const f of files) {
      const ext = extOf(f.name) || (f.type.split("/")[1] ?? "bin");
      // Screenshots arrive as "image.png"; name them the way Obsidian does.
      const name = !f.name || /^image\.\w+$/.test(f.name) ? `Pasted image ${stamp}.${ext}` : f.name;
      try {
        const saved = await host.saveAttachment(folder, name, new Uint8Array(await f.arrayBuffer()));
        ws.index.setFile(saved, true);
        const r = ws.index.resolveFile(fileName(saved)) === saved ? fileName(saved) : saved;
        refs.push(isMedia(extOf(saved)) ? `![[${r}]]` : `[[${r}]]`);
      } catch (e) {
        p.onNotice(`Couldn't save ${f.name}: ${(e as Error).message}`);
      }
    }
    const v = view.current;
    if (!v || !refs.length) return;
    const line = v.state.doc.lineAt(pos);
    // Embeds draw as blocks only on a line of their own.
    const before = pos > line.from && line.text.slice(0, pos - line.from).trim() ? "\n" : "";
    const after = pos < line.to ? "\n" : "";
    const text = before + refs.join("\n") + after;
    v.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length } });
    v.focus();
  };

  if (!note) return null;

  return (
    <div className={`pane-note${p.focused ? " focused" : ""}`} onFocusCapture={p.onFocus} onMouseDown={p.onFocus}>
      <div className="note-head">
        <span className="crumb">{note.folder}</span>
        <input
          key={path}
          className="title"
          defaultValue={note.name}
          onBlur={(e) => p.onRename(path, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              (e.target as HTMLInputElement).value = note.name;
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        <button className="ghost" title="Ask Claude where this note belongs (⇧⌘O)" onClick={() => p.onOrganize(path)}>Organize</button>
      </div>
      {conflict && (
        <div className="banner">
          This note was changed outside Railnote while you were editing.
          <button
            onClick={() => {
              const disk = ws.index.notes.get(path)?.content ?? "";
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
              await ws.write(path, draft.current);
            }}
          >
            Keep mine
          </button>
        </div>
      )}
      <Editor
        path={path}
        initial={initial}
        reloadKey={reloadKey}
        index={ws.index}
        autoFocus={p.focused}
        onChange={(content) => {
          draft.current = content;
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => void flushRef.current(), 400);
        }}
        onOpenLink={p.onOpenLink}
        onOpenUrl={(u) => host.openExternal(u)}
        hooks={{
          resolveFile: (src) => {
            const f = ws.index.resolveFile(src, noteFolder(path));
            return f ? { path: f, version: ws.index.files.get(f) ?? 0 } : null;
          },
          resolveNote: (t) => ws.index.resolve(t),
          noteContent: (n) => ws.index.notes.get(n)?.content ?? null,
          openInSystem: (f) => void host.openInSystem(f).catch((e) => p.onNotice((e as Error).message)),
        }}
        onFiles={addFiles}
        onView={(v) => {
          view.current = v;
          if (v && pendingLine.current != null) gotoLine(pendingLine.current);
        }}
      />
    </div>
  );
});
