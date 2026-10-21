import { useMemo } from "react";
import { whereFrom, type OpenWhere } from "../editor/hooks";
import { folderLines, lineColour } from "../lib/lines";
import { renderInline } from "../lib/markdown";
import { escapeRe } from "../lib/vault-index";
import { host, type Workspace } from "../workspace";

interface Props {
  ws: Workspace;
  path: string;
  /** Bumped when the index changes, so the lists follow edits elsewhere. */
  version: number;
  onOpen(path: string, where: OpenWhere): void;
  onOpenLink(target: string, where: OpenWhere): void;
}

/** The end of the page: which notes link here, and which mention this note without linking. */
export function Connections({ ws, path, version, onOpen, onOpenLink }: Props) {
  const idx = ws.index;
  const back = useMemo(() => idx.backlinks(path), [path, version]);
  const unlinked = useMemo(() => idx.unlinkedMentions(path), [path, version]);
  const lines = useMemo(() => folderLines(idx), [version]);
  const name = idx.notes.get(path)?.name ?? "";

  const linkIt = async (source: string, line: string) => {
    const n = idx.notes.get(source);
    if (!n) return;
    const re = new RegExp(`\\b(${escapeRe(name)})\\b`, "i");
    const next = n.content.replace(line, line.replace(re, (m) => (m === name ? `[[${name}]]` : `[[${name}|${m}]]`)));
    if (next !== n.content) await ws.write(source, next);
  };

  const follow = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>("[data-link],[data-href]");
    if (!a) return false;
    e.stopPropagation();
    if (a.dataset.link) onOpenLink(a.dataset.link, whereFrom(e));
    else if (a.dataset.href) host.openExternal(a.dataset.href);
    return true;
  };

  return (
    <section className="rn-connections" aria-label="Connections">
      <h2>{back.length ? `Linked from ${back.length} ${back.length === 1 ? "note" : "notes"}` : "Nothing links here yet"}</h2>
      {back.map((b) => (
        <div key={b.source.path} className="conn" style={{ "--track": lineColour(lines, b.source.path) } as React.CSSProperties}>
          <button className="conn-name" onClick={(e) => onOpen(b.source.path, whereFrom(e))} title={b.source.path}>{b.source.name}</button>
          {b.lines.map((l, i) => (
            <p key={i} className="conn-line" onClick={(e) => follow(e) || onOpen(b.source.path, whereFrom(e))} dangerouslySetInnerHTML={{ __html: renderInline(l.replace(/^#+\s+|^\s*[-*+]\s+(\[.\]\s+)?/, "")) }} />
          ))}
        </div>
      ))}
      {unlinked.length > 0 && (
        <>
          <h3>Mentioned without a link</h3>
          {unlinked.map((u) => (
            <div key={u.source.path} className="conn quiet" style={{ "--track": lineColour(lines, u.source.path) } as React.CSSProperties}>
              <button className="conn-name" onClick={(e) => onOpen(u.source.path, whereFrom(e))} title={u.source.path}>{u.source.name}</button>
              {u.lines.map((l, i) => (
                <div key={i} className="conn-mention">
                  <p className="conn-line" onClick={follow} dangerouslySetInnerHTML={{ __html: renderInline(l) }} />
                  <button className="mini" title={`Turn “${name}” into a link in ${u.source.name}`} onClick={() => linkIt(u.source.path, l)}>Link</button>
                </div>
              ))}
            </div>
          ))}
        </>
      )}
    </section>
  );
}
