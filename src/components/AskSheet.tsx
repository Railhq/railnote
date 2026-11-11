import { useEffect, useRef, useState } from "react";
import { stripNoteExt, type AskChange, type Settings } from "../../shared/types";
import { renderMarkdown } from "../lib/markdown";
import { excerpt } from "../lib/vault-index";
import { host, type Workspace } from "../workspace";

interface Props {
  ws: Workspace;
  open: boolean;
  onClose(): void;
  onOpen(path: string): void;
  onOpenLink(target: string): void;
  /** Deletes a note the agent made, when its change is undone. */
  onDelete(path: string): Promise<void>;
  settings: Settings;
  onSettings(s: Settings): void;
}

/** Ask, as a sheet that rises over the page (⌘J) and keeps the conversation while it's down. */
export function AskSheet(p: Props) {
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (p.open) input.current?.focus();
  }, [p.open]);
  // null: no switch, because only a coding agent on a computer can edit (an API key or the phone can't).
  const edits = host.kind === "phone" || p.settings.ai === "api" ? null : !!p.settings.agentEdits;
  const toggle = (on: boolean) => {
    void host.setSettings({ agentEdits: on }).then(p.onSettings);
    input.current?.focus();
  };
  return (
    <div className={`ask-sheet${p.open ? " open" : ""}`} aria-hidden={!p.open} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), p.onClose())}>
      <div className="ask-head">
        <span className="ask-title">{edits ? "Ask or tell your notes" : "Ask your notes"}</span>
        <button className="ghost" onClick={p.onClose} title="Put away (Esc)">Close</button>
      </div>
      <Ask {...p} input={input} edits={edits} onToggle={toggle} />
    </div>
  );
}

interface Turn {
  id: string;
  question: string;
  answer: string;
  sources: string[];
  done: boolean;
  error?: string;
  step?: string;
  started: number;
  changed?: AskChange[];
  /** Paths whose change was undone. */
  undone?: string[];
}

type AskProps = Props & { input: React.RefObject<HTMLTextAreaElement>; edits: boolean | null; onToggle(on: boolean): void };

function Ask({ ws, onOpen, onOpenLink, onDelete, input, edits, onToggle }: AskProps) {
  const [q, setQ] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [, setNow] = useState(0);
  const end = useRef<HTMLDivElement>(null);
  const working = turns.some((t) => !t.done);

  useEffect(
    () =>
      host.onAskEvent((e) =>
        setTurns((ts) =>
          ts.map((t) =>
            t.id !== e.id
              ? t
              : { ...t, answer: t.answer + (e.delta ?? ""), done: !!e.done, error: e.error ?? t.error, step: e.step ?? t.step, changed: e.changed ?? t.changed },
          ),
        ),
      ),
    [],
  );
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [turns]);
  // Ticks the elapsed time while an answer is on its way.
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [working]);

  const undo = async (turn: string, c: AskChange) => {
    if (c.before === null) await onDelete(c.path);
    else await ws.write(c.path, c.before);
    setTurns((ts) => ts.map((t) => (t.id === turn ? { ...t, undone: [...(t.undone ?? []), c.path] } : t)));
  };

  const submit = async () => {
    const question = q.trim();
    if (!question) return;
    setQ("");
    // Local search picks the likely notes: with an API key only these passages are sent; an agent gets them as hints.
    const hits = ws.index.searchText(question, 8);
    const sources = hits.map((h) => ({ path: h.path, text: excerpt(ws.index.notes.get(h.path)!.content, h.terms) }));
    const id = crypto.randomUUID();
    setTurns((ts) => [...ts, { id, question, answer: "", sources: hits.map((h) => h.path), done: false, started: Date.now() }]);
    await host.ask(id, question, sources);
  };

  return (
    <div className="ask">
      <div className="ask-turns">
        {!turns.length && (
          <div className="empty">
            {edits
              ? "Ask anything about your notes, or tell it to write or change them. Your coding agent (Claude Code, Codex or OpenCode, chosen in Settings) works in the vault on this computer, and every change it makes can be undone."
              : "Ask anything about your notes. Your coding agent (Claude Code, Codex or OpenCode, chosen in Settings) reads the vault on this computer to answer."}
          </div>
        )}
        {turns.map((t) => (
          <div key={t.id} className="turn">
            <div className="q">{t.question}</div>
            <div
              className="a"
              onClick={(e) => {
                const a = (e.target as HTMLElement).closest<HTMLElement>("[data-link],[data-href]");
                if (a?.dataset.link) onOpenLink(a.dataset.link);
                else if (a?.dataset.href) host.openExternal(a.dataset.href);
              }}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(t.answer) }}
            />
            {!t.done && (
              <div className="ask-working" role="status">
                <span className="ask-pulse" aria-hidden="true" />
                <span>{t.step ?? (t.answer ? "Still working" : "Thinking")}…</span>
                <span className="ask-elapsed">{Math.floor((Date.now() - t.started) / 1000)}s</span>
              </div>
            )}
            {t.error && <div className="error">{t.error}</div>}
            {t.done && !!t.changed?.length && (
              <ul className="ask-changes">
                {t.changed.map((c) => {
                  const undone = t.undone?.includes(c.path);
                  return (
                    <li key={c.path}>
                      <span className="ask-change-kind">{c.before === null ? "Made" : c.deleted ? "Deleted" : "Changed"}</span>
                      {c.deleted && !undone ? <span>{stripNoteExt(c.path)}</span> : !(c.before === null && undone) ? <a onClick={() => onOpen(c.path)}>{stripNoteExt(c.path)}</a> : <s>{stripNoteExt(c.path)}</s>}
                      {undone ? <span className="muted">Undone</span> : <button className="ghost small" onClick={() => void undo(t.id, c)}>Undo</button>}
                    </li>
                  );
                })}
              </ul>
            )}
            {t.done && t.sources.length > 0 && (
              <div className="sources">
                Searched:{" "}
                {t.sources.map((s) => (
                  <a key={s} onClick={() => onOpen(s)}>{stripNoteExt(s)}</a>
                ))}
              </div>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="ask-compose">
        <textarea
          ref={input}
          className="ask-input"
          placeholder={edits ? "Ask, or tell it what to write…  (Enter to send)" : "Ask your notes…  (Enter to send)"}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {edits !== null && (
          <label className="ask-edits" title="Let the agent create and change notes. Each change can be undone here or from the note's history.">
            <input type="checkbox" checked={edits} onChange={(e) => onToggle(e.target.checked)} />
            {edits ? "Can edit notes" : "Read only"}
          </label>
        )}
      </div>
    </div>
  );
}
