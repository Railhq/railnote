import { useMemo, useState } from "react";
import type { OrganizeSuggestion } from "../../shared/types";
import { host, isoDate, join, Workspace } from "../workspace";
import { renderInline } from "../lib/markdown";
import { folderLines, lineColour } from "../lib/lines";

/** Every checkbox in the vault, grouped by note. */
export function TasksView({ ws, onOpen }: { ws: Workspace; onOpen(path: string, line?: number): void }) {
  const [filter, setFilter] = useState<"open" | "done" | "all">("open");
  const groups = useMemo(
    () =>
      ws.index
        .all()
        .map((n) => ({ note: n, tasks: n.parsed.tasks.filter((t) => filter === "all" || (filter === "done") === t.done) }))
        .filter((g) => g.tasks.length)
        .sort((a, b) => b.note.mtime - a.note.mtime),
    [ws.index.version, filter],
  );
  return (
    <div className="page">
      <div className="page-head">
        <h1>Tasks</h1>
        <div className="seg">
          {(["open", "done", "all"] as const).map((f) => (
            <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{f}</button>
          ))}
        </div>
      </div>
      <p className="muted">Any line like <code>- [ ] something</code> in any note shows up here.</p>
      {!groups.length && <div className="empty">No {filter === "all" ? "" : filter} tasks.</div>}
      {groups.map((g) => (
        <div key={g.note.path} className="task-group">
          <div className="task-note" onClick={() => onOpen(g.note.path)}>{g.note.name}</div>
          {g.tasks.map((t) => (
            <label key={t.line} className={`task${t.done ? " done" : ""}`}>
              <input type="checkbox" checked={t.done} onChange={() => ws.toggleTask(g.note.path, t.line)} />
              <span onClick={(e) => { e.preventDefault(); onOpen(g.note.path, t.line); }}>{t.text}</span>
            </label>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Inbox triage: captures waiting for a home. */
export function InboxView({ ws, onOpen, onOrganize, onNew }: { ws: Workspace; onOpen(p: string): void; onOrganize(p: string): void; onNew(): void }) {
  const notes = ws.index.all().filter((n) => n.folder === ws.settings.inboxFolder).sort((a, b) => b.mtime - a.mtime);
  return (
    <div className="page">
      <div className="page-head">
        <h1>Inbox</h1>
        <button className="primary" onClick={() => onNew()}>Capture a note</button>
      </div>
      <p className="muted">Write first, file later. Organize asks Claude where a note belongs; you approve each change.</p>
      {!notes.length && <div className="empty">Inbox zero.</div>}
      {notes.map((n) => (
        <div key={n.path} className="inbox-row">
          <div className="inbox-main" onClick={() => onOpen(n.path)}>
            <div className="inbox-name">{n.name}</div>
            <div className="inbox-preview">{n.content.slice(n.parsed.bodyStart).replace(/[#*>`\-\[\]]/g, "").trim().slice(0, 160) || "Empty"}</div>
          </div>
          <button onClick={() => onOrganize(n.path)}>Organize</button>
        </div>
      ))}
    </div>
  );
}

export function OrganizeDialog({ ws, path, onClose, onDone }: { ws: Workspace; path: string; onClose(): void; onDone(newPath: string): void }) {
  const [s, setS] = useState<OrganizeSuggestion | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [useFolder, setUseFolder] = useState(true);
  const [tags, setTags] = useState<Set<string>>(new Set());
  const [links, setLinks] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const note = ws.index.notes.get(path);

  useMemo(() => {
    if (!note) return;
    const idx = ws.index;
    host
      .organize({
        path,
        content: note.content,
        folders: idx.folders(),
        tags: [...idx.tags().keys()],
        noteNames: idx.all().filter((n) => n.path !== path).map((n) => n.name).slice(0, 400),
      })
      .then((r) => {
        setS(r);
        setTags(new Set(r.tags));
        setLinks(new Set(r.links.map((l) => l.note)));
        setUseFolder(r.folder !== note.folder);
      })
      .catch((e) => setErr(String(e.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const flip = (set: Set<string>, v: string, put: (s: Set<string>) => void) => {
    const n = new Set(set);
    n.has(v) ? n.delete(v) : n.add(v);
    put(n);
  };

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Organize “{note?.name}”</h3>
        {!s && !err && <div className="muted">Asking Claude…</div>}
        {err && <div className="error">{err}</div>}
        {s && (
          <>
            <p className="muted">{s.summary}</p>
            <h4>Folder</h4>
            <label className="check">
              <input type="checkbox" checked={useFolder} disabled={s.folder === note?.folder} onChange={() => setUseFolder(!useFolder)} />
              Move to <code>{s.folder || "(vault root)"}</code>
              {s.folder === note?.folder && <span className="muted"> (already there)</span>}
            </label>
            <h4>Tags</h4>
            {s.tags.map((t) => (
              <label key={t} className="check">
                <input type="checkbox" checked={tags.has(t)} onChange={() => flip(tags, t, setTags)} />#{t}
              </label>
            ))}
            <h4>Links</h4>
            {!s.links.length && <div className="muted">No related notes found.</div>}
            {s.links.map((l) => (
              <label key={l.note} className="check">
                <input type="checkbox" checked={links.has(l.note)} onChange={() => flip(links, l.note, setLinks)} />
                <span>[[{l.note}]] <span className="muted">{l.reason}</span></span>
              </label>
            ))}
          </>
        )}
        <div className="dialog-foot">
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={!s || busy}
            onClick={async () => {
              setBusy(true);
              try {
                onDone(await ws.applyOrganize(path, s!, { folder: useFolder, tags: [...tags], links: [...links] }));
              } catch (e) {
                setErr((e as Error).message);
                setBusy(false);
              }
            }}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

const ago = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : d < 30 ? `${d} days ago` : new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

/** Where a day starts: today's note, what's waiting to be filed, what's left to do, and where you were. */
export function HomeView({ ws, route, here, onDaily, onOpen, onOrganize, onView }: {
  ws: Workspace;
  /** The route the pane in use was on, to step back into. */
  route: string[];
  here: string | null;
  onDaily(): void;
  onOpen(path: string, line?: number): void;
  onOrganize(path: string): void;
  onView(v: "inbox" | "tasks"): void;
}) {
  const v = ws.index.version;
  const today = isoDate();
  const lines = useMemo(() => folderLines(ws.index), [v]);
  const daily = ws.index.notes.get(join(ws.settings.dailyFolder, `${today}.md`));
  const inbox = useMemo(() => ws.index.all().filter((n) => n.folder === ws.settings.inboxFolder).sort((a, b) => b.mtime - a.mtime), [v]);
  const tasks = useMemo(
    () => ws.index.all().filter((n) => !n.path.startsWith(ws.settings.templatesFolder + "/")).sort((a, b) => b.mtime - a.mtime)
      .flatMap((n) => n.parsed.tasks.filter((t) => !t.done).map((t) => ({ note: n, task: t }))),
    [v],
  );
  const recent = useMemo(() => ws.index.all().filter((n) => n !== daily && n.folder !== ws.settings.inboxFolder && !n.path.startsWith(ws.settings.templatesFolder + "/")).sort((a, b) => b.mtime - a.mtime).slice(0, 8), [v, daily]);
  const body = daily ? daily.content.slice(daily.parsed.bodyStart).split("\n").filter((l) => l.trim() && !/^#\s/.test(l)).slice(0, 4) : [];
  const date = new Date(`${today}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const dot = (path: string) => ({ "--track": lineColour(lines, path) }) as React.CSSProperties;

  return (
    <div className="page home">
      <h1 className="home-date">{date}</h1>

      {route.length > 0 && (
        <section className="home-block">
          <h2>Pick up where you left off</h2>
          <div className="home-route">
            {route.map((t, k) => (
              <button
                key={t}
                className={`stop${t === here ? " active" : ""}`}
                style={{ "--track": k ? lineColour(lines, t) : "transparent", "--next": k < route.length - 1 ? lineColour(lines, route[k + 1]) : "transparent" } as React.CSSProperties}
                onClick={() => onOpen(t)}
              >
                <span className="stop-dot" aria-hidden="true" />
                <span className="tab-name">{ws.index.notes.get(t)?.name ?? t}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="home-today" style={daily ? dot(daily.path) : undefined}>
        {daily ? (
          <>
            <button className="home-today-open" onClick={onDaily}>Today's note</button>
            {body.length ? body.map((l, i) => <p key={i} onClick={onDaily} dangerouslySetInnerHTML={{ __html: renderInline(l.replace(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+|>\s*)/, "")) }} />) : <p className="muted">Nothing written yet.</p>}
          </>
        ) : (
          <button className="primary" onClick={onDaily}>Start today's note</button>
        )}
      </section>

      {inbox.length > 0 && (
        <section className="home-block">
          <h2><button className="link-head" onClick={() => onView("inbox")}>Waiting in the inbox</button> <span className="muted">{inbox.length}</span></h2>
          {inbox.slice(0, 4).map((n) => (
            <div key={n.path} className="home-row">
              <button className="home-name" onClick={() => onOpen(n.path)}>{n.name}</button>
              <button className="mini" onClick={() => onOrganize(n.path)}>Organize</button>
            </div>
          ))}
        </section>
      )}

      {tasks.length > 0 && (
        <section className="home-block">
          <h2><button className="link-head" onClick={() => onView("tasks")}>Still to do</button> <span className="muted">{tasks.length}</span></h2>
          {tasks.slice(0, 6).map(({ note, task }) => (
            <label key={note.path + task.line} className="task home-task">
              <input type="checkbox" checked={false} onChange={() => ws.toggleTask(note.path, task.line)} />
              <span onClick={(e) => { e.preventDefault(); onOpen(note.path, task.line); }} dangerouslySetInnerHTML={{ __html: renderInline(task.text) }} />
              <em className="home-from" style={dot(note.path)}>{note.name}</em>
            </label>
          ))}
        </section>
      )}

      {recent.length > 0 && (
        <section className="home-block">
          <h2>Where you were</h2>
          {recent.map((n) => (
            <div key={n.path} className="home-row recent" style={dot(n.path)}>
              <button className="home-name" onClick={() => onOpen(n.path)}>{n.name}</button>
              <span className="muted">{ago(n.mtime)}</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
