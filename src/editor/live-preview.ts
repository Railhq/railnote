import { syntaxTree } from "@codemirror/language";
import { EditorState, Range, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { LINK_RE, parseFrontmatter } from "../lib/parse";
import { CanvizWidget } from "./canviz-widget";

// "Live preview lite": Markdown syntax hides on every line except the ones the cursor is on,
// so notes read like a document while staying plain text underneath.

function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number, b = state.doc.lineAt(r.to).number;
    for (let i = a; i <= b; i++) lines.add(i);
  }
  return lines;
}

const hide = Decoration.replace({});

class Bullet extends WidgetType {
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-rn-bullet";
    s.textContent = "•";
    return s;
  }
}

class Checkbox extends WidgetType {
  constructor(readonly checked: boolean, readonly pos: number) {
    super();
  }
  eq(o: Checkbox) {
    return o.checked === this.checked && o.pos === this.pos;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-rn-task";
    box.checked = this.checked;
    box.onmousedown = (e) => e.preventDefault();
    box.onclick = (e) => {
      e.preventDefault();
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? " " : "x" } });
    };
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

class HRule extends WidgetType {
  toDOM() {
    const hr = document.createElement("span");
    hr.className = "cm-rn-hr";
    return hr;
  }
}

function buildInline(view: EditorView): DecorationSet {
  const { state } = view;
  const active = activeLines(state);
  const decos: Range<Decoration>[] = [];
  const onActive = (pos: number) => active.has(state.doc.lineAt(pos).number);
  // Frontmatter reads as properties, not prose: the Markdown grammar would make it a setext heading.
  const fmEnd = parseFrontmatter(state.sliceDoc(0, Math.min(state.doc.length, 8000))).end;
  for (let pos = 0; pos < fmEnd; ) {
    const line = state.doc.lineAt(pos);
    decos.push(Decoration.line({ class: "cm-rn-fm" }).range(line.from));
    pos = line.to + 1;
  }

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.from < fmEnd) return node.to > fmEnd;
        const name = node.name;
        const heading = /^ATXHeading(\d)$/.exec(name);
        if (heading) {
          decos.push(Decoration.line({ class: `cm-rn-h cm-rn-h${heading[1]}` }).range(state.doc.lineAt(node.from).from));
          return;
        }
        if (name === "FencedCode" || name === "CodeBlock") {
          for (let p = node.from; p <= node.to; ) {
            const line = state.doc.lineAt(p);
            decos.push(Decoration.line({ class: "cm-rn-codeblock" }).range(line.from));
            p = line.to + 1;
          }
          return false;
        }
        if (name === "Blockquote") {
          for (let p = node.from; p <= node.to; ) {
            const line = state.doc.lineAt(p);
            decos.push(Decoration.line({ class: "cm-rn-quote" }).range(line.from));
            p = line.to + 1;
          }
        }
        if (onActive(node.from)) return;
        switch (name) {
          case "HeaderMark": {
            // Hide "## " including the trailing space.
            const end = Math.min(node.to + 1, state.doc.lineAt(node.from).to);
            decos.push(hide.range(node.from, end));
            break;
          }
          case "EmphasisMark":
          case "StrikethroughMark":
          case "QuoteMark":
            decos.push(hide.range(node.from, node.to));
            break;
          case "CodeMark":
            if (node.node.parent?.name === "InlineCode") decos.push(hide.range(node.from, node.to));
            break;
          case "ListMark": {
            const next = state.sliceDoc(node.to, node.to + 4);
            if (/^ \[[ xX]\]/.test(next)) decos.push(hide.range(node.from, node.to + 1));
            else if (/^[-*+]$/.test(state.sliceDoc(node.from, node.to))) decos.push(Decoration.replace({ widget: new Bullet() }).range(node.from, node.to));
            break;
          }
          case "TaskMarker": {
            const checked = /x/i.test(state.sliceDoc(node.from, node.to));
            decos.push(Decoration.replace({ widget: new Checkbox(checked, node.from) }).range(node.from, node.to));
            if (checked) {
              const line = state.doc.lineAt(node.from);
              decos.push(Decoration.mark({ class: "cm-rn-done" }).range(node.to, line.to));
            }
            break;
          }
          case "HorizontalRule":
            decos.push(Decoration.replace({ widget: new HRule() }).range(node.from, node.to));
            break;
          case "Link": {
            // [text](url): show only the text.
            const text = state.sliceDoc(node.from, node.to);
            const m = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(text);
            if (m) {
              decos.push(hide.range(node.from, node.from + 1));
              decos.push(Decoration.mark({ class: "cm-rn-extlink", attributes: { "data-href": m[2] } }).range(node.from + 1, node.from + 1 + m[1].length));
              decos.push(hide.range(node.from + 1 + m[1].length, node.to));
            }
            return false;
          }
        }
      },
    });

    // Wikilinks aren't in the Markdown grammar; find them per visible line.
    for (let pos = from; pos <= to; ) {
      const line = state.doc.lineAt(pos);
      for (const m of line.text.matchAll(LINK_RE)) {
        const start = line.from + m.index!;
        const end = start + m[0].length;
        const target = m[2].trim();
        if (!target || /\.canviz$/i.test(target)) continue;
        const cls = `cm-rn-wikilink${resolveHook(target) ? "" : " cm-rn-unresolved"}`;
        const attrs = { "data-link": target + (m[3] ?? "") };
        if (active.has(line.number)) {
          decos.push(Decoration.mark({ class: cls, attributes: attrs }).range(start, end));
          continue;
        }
        const open = m[1].length + 2;
        const label = m[4] !== undefined ? m[4] : null;
        if (label !== null) {
          const labelStart = end - 2 - label.length;
          decos.push(hide.range(start, labelStart));
          decos.push(Decoration.mark({ class: cls, attributes: attrs }).range(labelStart, end - 2));
        } else {
          decos.push(hide.range(start, start + open));
          decos.push(Decoration.mark({ class: cls, attributes: attrs }).range(start + open, end - 2));
        }
        decos.push(hide.range(end - 2, end));
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(decos, true);
}

/** Dispatch to redraw link styling after the vault changes (a link may have become resolved). */
export const refreshPreview = StateEffect.define<null>();

/** Set by the app so the editor can style unresolved links without importing the index. */
let resolveHook: (target: string) => boolean = () => true;
export function setLinkResolver(fn: (target: string) => boolean) {
  resolveHook = fn;
}

export const inlinePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildInline(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || u.transactions.some((t) => t.effects.some((e) => e.is(refreshPreview))) || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = buildInline(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** Explainer blocks (```canviz fences and ![[x.canviz]] embeds) become players unless the cursor is inside. */
function buildBlocks(state: EditorState): DecorationSet {
  const active = activeLines(state);
  const builder = new RangeSetBuilder<Decoration>();
  const doc = state.doc;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    if (/^```canviz\s*$/.test(line.text)) {
      let j = i + 1;
      while (j <= doc.lines && !/^```\s*$/.test(doc.line(j).text)) j++;
      if (j > doc.lines) break;
      const end = doc.line(j);
      let touched = false;
      for (let k = i; k <= j; k++) if (active.has(k)) touched = true;
      const source = doc.sliceString(doc.line(i).to + 1, end.from).trim();
      if (!touched) builder.add(line.from, end.to, Decoration.replace({ widget: new CanvizWidget(source), block: true }));
      i = j;
      continue;
    }
    const embed = /^\s*!\[\[([^\]|]+\.canviz)(?:\|[^\]]*)?\]\]\s*$/i.exec(line.text);
    if (embed && !active.has(i)) {
      builder.add(line.from, line.to, Decoration.replace({ widget: new CanvizWidget(`src: ${embed[1]}`), block: true }));
    }
  }
  return builder.finish();
}

export const blockPreview = StateField.define<DecorationSet>({
  create: buildBlocks,
  update(deco, tr) {
    return tr.docChanged || tr.selection ? buildBlocks(tr.state) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
