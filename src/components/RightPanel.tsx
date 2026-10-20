import { useEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "../lib/markdown";
import { escapeRe, excerpt } from "../lib/vault-index";
import { host, Workspace } from "../workspace";

interface Props {
  ws: Workspace;
  current: string | null;
  tab: "links" | "outline" | "ask";
  onTab(t: Props["tab"]): void;
  onOpen(path: string, line?: number): void;
  onOpenLink(target: string): void;
}

export function RightPanel(p: Props) {
  return (
    <aside className="right">
      <div className="drag-region" />
      <div className="tabs">
        {(["links", "outline", "ask"] as const).map((t) => (
          <button key={t} className={p.tab === t ? "on" : ""} onClick={() => p.onTab(t)}>
            {t === "ask" ? "✦ Ask" : t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <div className="side-body">
        {p.tab === "links" && <Links {...p} />}
        {p.tab === "outline" && <Outline {...p} />}
        <div style={{ display: p.tab === "ask" ? "block" : "none" }}>
          <Ask {...p} />
        </div>
      </div>
    </aside>
  );
}

function Links({ ws, current, onOpen }: Props) {
  const idx = ws.index;
  const back = useMemo(() => (current ? idx.backlinks(current) : []), [current, idx.version]);
  const unlinked = useMemo(() => (current ? idx.unlinkedMentions(current) : []), [current, idx.version]);
  if (!current) return <div className="empty">Open a note to see what links to it.</div>;
  const name = idx.notes.get(current)?.name ?? "";

  const linkIt = async (path: string, line: string) => {
    const n = idx.notes.get(path);
    if (!n) return;
    const re = new RegExp(`\\b(${escapeRe(name)})\\b`, "i");
    const next = n.content.replace(line, line.replace(re, (m) => (m === name ? `[[${name}]]` : `[[${name}|${m}]]`)));
    if (next !== n.content) await ws.write(path, next);
  };

  return (
    <>
      <h4>Backlinks <span className="count">{back.length}</span></h4>
      {!back.length && <div className="empty">No notes link here yet.</div>}
      {back.map((b) => (
        <div key={b.source.path} className="ref" onClick={() => onOpen(b.source.path)}>
          <div className="ref-name">{b.source.name}</div>
          {b.lines.map((l, i) => <div key={i} className="ref-line">{l}</div>)}
        </div>
      ))}
      <h4>Unlinked mentions <span className="count">{unlinked.length}</span></h4>
      {unlinked.map((u) => (
        <div key={u.source.path} className="ref">
          <div className="ref-name" onClick={() => onOpen(u.source.path)}>{u.source.name}</div>
          {u.lines.map((l, i) => (
            <div key={i} className="ref-line">
              {l}
              <button className="mini" onClick={() => linkIt(u.source.path, l)}>Link</button>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

function Outline({ ws, current, onOpen }: Props) {
  const n = current ? ws.index.notes.get(current) : undefined;
  if (!n) return <div className="empty">No note open.</div>;
  if (!n.parsed.headings.length) return <div className="empty">This note has no headings.</div>;
  return (
    <>
      {n.parsed.headings.map((h) => (
        <div key={h.line} className="outline-item" style={{ paddingLeft: (h.level - 1) * 12 + 8 }} onClick={() => onOpen(n.path, h.line)}>
          {h.text}
        </div>
      ))}
    </>
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

function Ask({ ws, onOpen, onOpenLink }: Props) {
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
      <textarea
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
