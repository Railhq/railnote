import { useEffect, useRef, useState } from "react";
import { closeBrackets } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { bracketMatching, foldGutter, HighlightStyle, LanguageDescription, syntaxHighlighting, type LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { drawSelection, EditorView, keymap, lineNumbers } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { host } from "../workspace";

const jsonColors = HighlightStyle.define([
  { tag: t.propertyName, color: "var(--link)" },
  { tag: t.string, color: "var(--ink-2)" },
  { tag: [t.number, t.bool, t.null], color: "var(--line-2)" },
  { tag: [t.brace, t.squareBracket, t.punctuation, t.separator], color: "var(--muted)" },
]);

const codeColors = HighlightStyle.define([
  { tag: t.keyword, color: "#c678dd" },
  { tag: [t.string, t.special(t.string)], color: "#98c379" },
  { tag: [t.number, t.bool, t.null], color: "#d19a66" },
  { tag: t.comment, color: "var(--muted)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#61afef" },
  { tag: [t.typeName, t.className], color: "#e5c07b" },
]);

/** Plain-text editor for a non-note vault file: the JSON behind an embedded explainer, a script, a .txt. */
export function SourceView({ path, backLabel, onBack }: { path: string; backLabel: string; onBack(): void }) {
  const box = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string }>({ ok: true, text: "Loading…" });
  const back = useRef(onBack);
  back.current = onBack;
  // Leaving must wait for the last write, or the note's player reloads the old file.
  const saveNow = useRef<() => Promise<void>>(async () => {});
  const leave = async () => {
    await saveNow.current();
    back.current();
  };

  useEffect(() => {
    let view: EditorView | undefined;
    let timer: number | undefined;
    let saved = "";
    let alive = true;
    const isJson = /\.json$/i.test(path);
    const check = (text: string) => {
      if (!isJson) return null;
      try {
        JSON.parse(text);
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    };
    const save = async () => {
      window.clearTimeout(timer);
      if (!view) return;
      const text = view.state.doc.toString();
      if (text === saved) return;
      saved = text;
      await host.write(path, text);
      const bad = check(text);
      if (alive) setStatus(bad ? { ok: false, text: `Saved, but the JSON isn't valid yet: ${bad}` } : { ok: true, text: "Saved" });
    };
    saveNow.current = save;
    const lang: Promise<LanguageSupport | null> = isJson
      ? Promise.resolve(json())
      : (LanguageDescription.matchFilename(languages, path)?.load() ?? Promise.resolve(null)).catch(() => null);
    Promise.all([host.readRaw(path), lang])
      .then(([text, support]) => {
        if (!alive || !box.current) return;
        saved = text;
        const bad = check(text);
        setStatus(bad ? { ok: false, text: `The JSON isn't valid: ${bad}` } : { ok: true, text: "Changes save as you type." });
        view = new EditorView({
          parent: box.current,
          state: EditorState.create({
            doc: text,
            extensions: [
              lineNumbers(),
              foldGutter(),
              history(),
              drawSelection(),
              closeBrackets(),
              bracketMatching(),
              highlightSelectionMatches(),
              support ?? [],
              syntaxHighlighting(isJson ? jsonColors : codeColors),
              keymap.of([
                { key: "Escape", run: () => (void leave(), true) },
                { key: "Mod-s", run: () => (void save(), true) },
                ...defaultKeymap,
                ...historyKeymap,
                ...searchKeymap,
                indentWithTab,
              ]),
              EditorView.updateListener.of((u) => {
                if (!u.docChanged) return;
                window.clearTimeout(timer);
                timer = window.setTimeout(save, 400);
              }),
            ],
          }),
        });
        view.focus();
      })
      .catch((e) => alive && setStatus({ ok: false, text: `Couldn't open ${path}: ${(e as Error).message}` }));
    return () => {
      alive = false;
      void save();
      view?.destroy();
    };
  }, [path]);

  const slash = path.lastIndexOf("/");
  return (
    <>
      <div className="note-head">
        <span className="crumb">{slash > 0 ? path.slice(0, slash) : ""}</span>
        <div className="title source-title">{path.slice(slash + 1)}</div>
        <button className="ghost" title="Esc" onClick={leave}>Back to {backLabel}</button>
      </div>
      <div className={`source-status${status.ok ? "" : " bad"}`}>{status.text}</div>
      <div className="source-editor" ref={box} />
    </>
  );
}
