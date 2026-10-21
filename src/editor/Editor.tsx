import { useEffect, useRef } from "react";
import { autocompletion, closeBrackets, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { drawSelection, EditorView, keymap, placeholder } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { blockPreview, inlinePreview, refreshPreview } from "./live-preview";
import { editorHooks, EditorHooks } from "./hooks";
import type { VaultIndex } from "../lib/vault-index";
import { plugins } from "../plugins/host";

const highlight = HighlightStyle.define([
  { tag: t.heading1, fontWeight: "700" },
  { tag: [t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: "650" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.monospace, fontFamily: "var(--mono)", class: "cm-rn-inlinecode" },
  { tag: [t.processingInstruction, t.meta], color: "var(--muted)" },
  { tag: t.link, color: "var(--accent)" },
  { tag: t.url, color: "var(--muted)" },
  { tag: t.quote, color: "var(--text-2)" },
  { tag: t.keyword, color: "#c678dd" },
  { tag: [t.string, t.special(t.string)], color: "#98c379" },
  { tag: [t.number, t.bool, t.null], color: "#d19a66" },
  { tag: t.comment, color: "var(--muted)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.propertyName], color: "#61afef" },
  { tag: t.typeName, color: "#e5c07b" },
]);

function wikilinkCompletions(index: VaultIndex) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const m = ctx.matchBefore(/!?\[\[[^\]\n]*/);
    if (!m) return null;
    const open = m.text.indexOf("[[") + 2;
    const query = m.text.slice(open);
    if (query.includes("|") || query.includes("#")) return null;
    const after = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2);
    const options = index.quickFind(query, 40).map((n) => ({
      label: n.name,
      detail: n.folder || undefined,
      apply: n.name + (after === "]]" ? "" : "]]"),
    }));
    if (query && !options.some((o) => o.label.toLowerCase() === query.toLowerCase())) {
      options.push({ label: query, detail: "new note", apply: query + (after === "]]" ? "" : "]]") });
    }
    return { from: m.from + open, options, filter: false };
  };
}

export interface EditorProps {
  path: string;
  initial: string;
  /** Bump to replace the document with `initial` (an external edit was accepted). */
  reloadKey: number;
  index: VaultIndex;
  onChange(content: string): void;
  onOpenLink(target: string, newPane: boolean): void;
  onOpenUrl(url: string): void;
  onView?(view: EditorView | null): void;
  /** Attachment and note lookups for previews. */
  hooks: Pick<EditorHooks, "resolveFile" | "resolveNote" | "noteContent" | "openInSystem">;
  /** Files pasted or dropped into the note; `pos` is where their embeds go. */
  onFiles(files: File[], pos: number): void;
}

export function Editor(props: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const state = EditorState.create({
      doc: props.initial,
      extensions: [
        history(),
        drawSelection(),
        closeBrackets(),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        syntaxHighlighting(highlight),
        highlightSelectionMatches(),
        autocompletion({ override: [wikilinkCompletions(props.index)], icons: false }),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        placeholder("Start writing…"),
        editorHooks.of({
          notePath: props.path,
          resolveFile: (src) => latest.current.hooks.resolveFile(src),
          resolveNote: (t) => latest.current.hooks.resolveNote(t),
          noteContent: (p) => latest.current.hooks.noteContent(p),
          openLink: (t, n) => latest.current.onOpenLink(t, n),
          openUrl: (u) => latest.current.onOpenUrl(u),
          openInSystem: (p) => latest.current.hooks.openInSystem(p),
        }),
        inlinePreview,
        blockPreview,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) latest.current.onChange(u.state.doc.toString());
        }),
        EditorView.domEventHandlers({
          paste(e, v) {
            const files = [...(e.clipboardData?.files ?? [])];
            if (!files.length) return false;
            e.preventDefault();
            latest.current.onFiles(files, v.state.selection.main.head);
            return true;
          },
          drop(e, v) {
            const files = [...(e.dataTransfer?.files ?? [])];
            if (!files.length) return false;
            e.preventDefault();
            latest.current.onFiles(files, v.posAtCoords({ x: e.clientX, y: e.clientY }) ?? v.state.selection.main.head);
            return true;
          },
          mousedown(e, v) {
            const el = (e.target as HTMLElement).closest<HTMLElement>("[data-link], [data-href]");
            if (!el) return false;
            const pos = v.posAtDOM(el);
            const onCursorLine = v.state.selection.ranges.some((r) => v.state.doc.lineAt(r.head).number === v.state.doc.lineAt(pos).number);
            // Rendered links follow on click; while editing the line, Cmd/Ctrl+click follows.
            if (onCursorLine && !(e.metaKey || e.ctrlKey)) return false;
            e.preventDefault();
            if (el.dataset.link) latest.current.onOpenLink(el.dataset.link, e.metaKey || e.ctrlKey);
            else if (el.dataset.href) latest.current.onOpenUrl(el.dataset.href);
            return true;
          },
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current! });
    view.current = v;
    props.onView?.(v);
    v.focus();
    return () => {
      props.onView?.(null);
      v.destroy();
      view.current = null;
    };
    // A new path is a new document (and a fresh undo history).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.path]);

  useEffect(() => {
    const v = view.current;
    if (!v || props.reloadKey === 0) return;
    const head = Math.min(v.state.selection.main.head, props.initial.length);
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: props.initial }, selection: { anchor: head } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.reloadKey]);

  useEffect(() => {
    view.current?.dispatch({ effects: refreshPreview.of(null) });
  }, [props.index.version]);

  // A plugin turned on or off changes which blocks it draws.
  useEffect(() => plugins.subscribe(() => view.current?.dispatch({ effects: refreshPreview.of(null) })), []);

  return <div className="editor" ref={host} />;
}
