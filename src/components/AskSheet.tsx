import { useEffect, useRef, useState } from "react";
import { renderMarkdown } from "../lib/markdown";
import { excerpt } from "../lib/vault-index";
import { host, type Workspace } from "../workspace";

interface Props {
  ws: Workspace;
  open: boolean;
  onClose(): void;
  onOpen(path: string): void;
  onOpenLink(target: string): void;
}

/** Ask, as a sheet that rises over the page (⌘J) and keeps the conversation while it's down. */
export function AskSheet(p: Props) {
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (p.open) input.current?.focus();
  }, [p.open]);
  return (
    <div className={`ask-sheet${p.open ? " open" : ""}`} aria-hidden={!p.open} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), p.onClose())}>
      <div className="ask-head">
        <span className="ask-title">Ask your notes</span>
        <button className="ghost" onClick={p.onClose} title="Put away (Esc)">Close</button>
      </div>
      <Ask {...p} input={input} />
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
}

function Ask({ ws, onOpen, onOpenLink, input }: Props & { input: React.RefObject<HTMLTextAreaElement> }) {
  const [q, setQ] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const end = useRef<HTMLDivElement>(null);

  useEffect(
    () =>
      host.onAskEvent((e) =>
        setTurns((ts) => ts.map((t) => (t.id !== e.id ? t : { ...t, answer: t.answer + (e.delta ?? ""), done: !!e.done, error: e.error ?? t.error }))),
      ),
    [],
  );
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [turns]);

  const submit = async () => {
    const question = q.trim();
    if (!question) return;
    setQ("");
    // Retrieval stays local: only the best-matching passages of the top notes go to Claude.
    const hits = ws.index.searchText(question, 8);
    const sources = hits.map((h) => ({ path: h.path, text: excerpt(ws.index.notes.get(h.path)!.content, h.terms) }));
    const id = crypto.randomUUID();
    setTurns((ts) => [...ts, { id, question, answer: "", sources: hits.map((h) => h.path), done: false }]);
    await host.ask(id, question, sources);
  };

  return (
    <div className="ask">
      <div className="ask-turns">
        {!turns.length && (
          <div className="empty">
            Ask anything about your notes. Railnote finds the relevant notes on this machine and sends only those passages to Claude.
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
              dangerouslySetInnerHTML={{ __html: renderMarkdown(t.answer || (t.done ? "" : "…")) }}
            />
            {t.error && <div className="error">{t.error}</div>}
            {t.done && t.sources.length > 0 && (
              <div className="sources">
                Searched:{" "}
                {t.sources.map((s) => (
                  <a key={s} onClick={() => onOpen(s)}>{s.replace(/\.md$/, "")}</a>
                ))}
              </div>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>
      <textarea
        ref={input}
        className="ask-input"
        placeholder="Ask your notes…  (Enter to send)"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
    </div>
  );
}
