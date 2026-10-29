import { useEffect, useMemo, useRef, useState } from "react";
import { diffLines, foldUnchanged } from "../../shared/diff";
import type { NoteVersion, VersionSource } from "../../shared/types";
import { host, isoDate, type Workspace } from "../workspace";

interface Props {
  ws: Workspace;
  path: string;
  onClose(): void;
  /** After a restore, with the text the note now has. */
  onRestored(text: string, from: NoteVersion): void;
  onNotice(message: string): void;
}

const SOURCE: Record<VersionSource, string> = {
  original: "Before Railnote's first edit",
  app: "Edited here",
  outside: "Changed outside Railnote",
  "before-restore": "Replaced by a restore",
  restored: "Restored",
  deleted: "Deleted",
};

const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function dayLabel(t: number) {
  const d = new Date(t);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (isoDate(d) === isoDate(today)) return "Today";
  if (isoDate(d) === isoDate(yesterday)) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

/** A note's saved versions as stops on a line, each shown against the note as it is now. */
export function HistorySheet({ ws, path, onClose, onRestored, onNotice }: Props) {
  const [versions, setVersions] = useState<NoteVersion[] | null>(null);
  const [sel, setSel] = useState(0);
  const [text, setText] = useState<string | null>(null);
  const [mode, setMode] = useState<"changes" | "text">("changes");
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const name = ws.index.notes.get(path)?.name ?? path;
  const current = ws.index.notes.get(path)?.content ?? "";
  const picked = versions?.[sel];

  useEffect(() => box.current?.focus(), []);

  useEffect(() => {
    host.history(path).then(setVersions, (e) => (onNotice((e as Error).message), setVersions([])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    if (!picked) return;
    let alive = true;
    setText(null);
    host.readVersion(path, picked.id).then(
      (t) => alive && setText(t),
      (e) => alive && onNotice((e as Error).message),
    );
    list.current?.querySelector(`[data-id="${picked.id}"]`)?.scrollIntoView({ block: "nearest" });
    return () => void (alive = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked?.id]);

  const rows = useMemo(() => (text === null ? null : foldUnchanged(diffLines(text, current))), [text, current]);
  const same = text !== null && text === current;

  const restore = async () => {
    if (!picked || busy || same) return;
    setBusy(true);
    try {
      onRestored(await host.restoreVersion(path, picked.id), picked);
    } catch (e) {
      onNotice(`Couldn't restore: ${(e as Error).message}`);
      setBusy(false);
    }
  };

  const copy = async () => {
    if (text === null) return;
    await navigator.clipboard.writeText(text);
    onNotice("Copied that version's text.");
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!versions?.length) return e.key === "Escape" && onClose();
    if (e.key === "ArrowDown") setSel((i) => Math.min(i + 1, versions.length - 1));
    else if (e.key === "ArrowUp") setSel((i) => Math.max(i - 1, 0));
    else if (e.key === "Escape") onClose();
    else return;
    e.preventDefault();
  };

  let lastDay = "";
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="history" role="dialog" aria-label={`Version history of ${name}`} tabIndex={-1} onKeyDown={onKey} onMouseDown={(e) => e.stopPropagation()} ref={box}>
        <header className="history-head">
          <div>
            <div className="history-title">{name}</div>
            <div className="history-sub">Saved versions, kept in this vault. ↑ ↓ to move along the line.</div>
          </div>
          <button className="ghost" onClick={onClose} title="Esc">Close</button>
        </header>
        {versions && !versions.length ? (
          <div className="history-empty">
            No saved versions yet. Railnote keeps one as you edit this note, and one whenever an agent or another app changes it.
          </div>
        ) : (
          <div className="history-body">
            <ol className="history-line" ref={list}>
              {versions?.map((v, i) => {
                const day = dayLabel(v.time);
                const head = day !== lastDay;
                lastDay = day;
                return (
                  <li key={v.id} data-id={v.id} className={`${head ? "day-start" : ""}${i === sel ? " sel" : ""} src-${v.source}`} onClick={() => setSel(i)}>
                    {head && <div className="history-day">{day}</div>}
                    <button className="history-stop" aria-current={i === sel} tabIndex={-1}>
                      <span className="history-dot" aria-hidden="true" />
                      <span className="history-time">{time(v.time)}</span>
                      <span className="history-src">{SOURCE[v.source]}</span>
                      {(v.added > 0 || v.removed > 0) && (
                        <span className="history-stat" title="Lines added and removed against the version before">
                          {v.added > 0 && <span className="plus">+{v.added}</span>}
                          {v.removed > 0 && <span className="minus">−{v.removed}</span>}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ol>
            <section className="history-view">
              <div className="history-tools">
                <div className="seg" role="tablist">
                  <button role="tab" aria-selected={mode === "changes"} className={mode === "changes" ? "on" : ""} onClick={() => setMode("changes")}>Changes since</button>
                  <button role="tab" aria-selected={mode === "text"} className={mode === "text" ? "on" : ""} onClick={() => setMode("text")}>This version</button>
                </div>
                <span className="spacer" />
                <button className="ghost" onClick={copy} disabled={text === null}>Copy</button>
                <button className="primary" onClick={restore} disabled={!picked || busy || text === null || same} title={same ? "The note already has this text" : "The note's current text is kept as a version too"}>
                  Restore this version
                </button>
              </div>
              <div className="history-text">
                {text === null ? null : mode === "text" ? (
                  <pre className="history-plain">{text}</pre>
                ) : same ? (
                  <p className="history-note">The note still reads exactly like this.</p>
                ) : (
                  <div className="history-diff">
                    <p className="history-note">What changed between this version and the note now: green is in the note now, red was only in this version.</p>
                    {rows!.map((r, i) =>
                      r.kind === "gap" ? (
                        <div key={i} className="d-gap">{r.count} unchanged lines</div>
                      ) : (
                        <div key={i} className={`d-${r.kind}`}>
                          <span className="d-mark" aria-hidden="true">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}</span>
                          {r.text || " "}
                        </div>
                      ),
                    )}
                  </div>
                )}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
