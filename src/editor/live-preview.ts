import { syntaxTree } from "@codemirror/language";
import { EditorState, Range, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { LINK_RE, parseFrontmatter } from "../lib/parse";
import { calloutGroup, calloutTitle, section } from "../lib/render";
import { extOf, isMedia } from "../lib/vault-index";
import { plugins } from "../plugins/host";
import { editorHooks } from "./hooks";
import { PluginWidget } from "./plugin-widget";
import { CalloutLabel, FootnoteWidget, HtmlWidget, MathWidget, MediaWidget, NoteEmbedWidget, TABLE_DELIM, TableWidget } from "./rich";

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

/** HTML that opens a block, as CommonMark counts it; inline tags like <span> stay in the paragraph. */
const HTML_OPEN = /^ {0,3}<(details|div|table|figure|section|aside|center|dl|ol|ul|p|h[1-6]|blockquote|pre|nav|header|footer|article|main)(?=[\s>/]|$)/i;

/** The last line of an HTML block: where its opening tag closes, or the first blank line if it never does. */
function htmlEnd(doc: EditorState["doc"], start: number, tag: string): number {
  const open = new RegExp(`<${tag}(?=[\\s>/])`, "gi"), close = new RegExp(`</${tag}\\s*>`, "gi");
  let depth = 0;
  for (let k = start; k <= Math.min(doc.lines, start + 500); k++) {
    const text = doc.line(k).text;
    depth += (text.match(open)?.length ?? 0) - (text.match(close)?.length ?? 0);
    if (depth <= 0) return k;
  }
  let k = start;
  while (k < doc.lines && doc.line(k + 1).text.trim()) k++;
  return k;
}

/** Strips the indent a list item gave the block, so its Markdown isn't read as code. */
function dedent(s: string) {
  const lines = s.split("\n");
  const pad = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length));
  return lines.map((l) => l.slice(pad)).join("\n");
}


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
          // > [!type] Title starts a callout, Obsidian style.
          const first = state.doc.lineAt(node.from);
          const co = /^(\s*>\s?)\[!([\w-]+)\]([+-]?)(\s*)(.*)$/.exec(first.text);
          for (let p = node.from; p <= node.to; ) {
            const line = state.doc.lineAt(p);
            const cls = co ? `cm-rn-callout cm-rn-co-${calloutGroup(co[2])}${line.number === first.number ? " cm-rn-callout-head" : ""}` : "cm-rn-quote";
            decos.push(Decoration.line({ class: cls }).range(line.from));
            p = line.to + 1;
          }
          if (co && !active.has(first.number)) {
            const at = first.from + co[1].length;
            const len = co[2].length + 3 + co[3].length + co[4].length;
            decos.push(Decoration.replace({ widget: new CalloutLabel(co[5].trim() ? "" : calloutTitle(co[2])) }).range(at, at + len));
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

    // Footnote definitions anywhere in the note, so a marker can show its text on hover.
    const defs = new Map<string, string>();
    for (let n = 1; n <= state.doc.lines; n++) {
      const d = /^\[\^([^\]\s]+)\]:\s*(.*)$/.exec(state.doc.line(n).text);
      if (d) defs.set(d[1], d[2]);
    }
    const inCode = (pos: number) => {
      for (let n: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent)
        if (/^(InlineCode|FencedCode|CodeBlock|CodeText)$/.test(n.name)) return true;
      return false;
    };
    // Highlights, inline math and footnotes aren't in the Markdown grammar either.
    for (let pos = Math.max(from, fmEnd); pos <= to; ) {
      const line = state.doc.lineAt(pos);
      const live = active.has(line.number);
      for (const m of line.text.matchAll(/==(?=\S)([^=\n]*?\S)==/g)) {
        const a = line.from + m.index!, b = a + m[0].length;
        if (inCode(a)) continue;
        if (live) decos.push(Decoration.mark({ class: "cm-rn-hl" }).range(a, b));
        else decos.push(hide.range(a, a + 2), Decoration.mark({ class: "cm-rn-hl" }).range(a + 2, b - 2), hide.range(b - 2, b));
      }
      if (!/^\s*\$\$/.test(line.text))
        for (const m of line.text.matchAll(/(?<![\\$])\$(?!\s)([^$\n]+?)(?<!\s)\$(?![\d$])/g)) {
          const a = line.from + m.index!, b = a + m[0].length;
          if (inCode(a)) continue;
          decos.push(live ? Decoration.mark({ class: "cm-rn-mathsrc" }).range(a, b) : Decoration.replace({ widget: new MathWidget(m[1], false) }).range(a, b));
        }
      const def = /^\[\^([^\]\s]+)\]:/.exec(line.text);
      if (def) {
        decos.push(Decoration.line({ class: "cm-rn-fn-line" }).range(line.from));
        if (!live) decos.push(Decoration.replace({ widget: new FootnoteWidget(def[1], undefined, true) }).range(line.from, line.from + def[0].length));
      }
      for (const m of line.text.matchAll(/\[\^([^\]\s]+)\](?!:)/g)) {
        const a = line.from + m.index!, b = a + m[0].length;
        if (inCode(a)) continue;
        decos.push(live ? Decoration.mark({ class: "cm-rn-fnsrc" }).range(a, b) : Decoration.replace({ widget: new FootnoteWidget(m[1], defs.get(m[1]), false) }).range(a, b));
      }
      pos = line.to + 1;
    }

    // Wikilinks aren't in the Markdown grammar; find them per visible line.
    for (let pos = from; pos <= to; ) {
      const line = state.doc.lineAt(pos);
      for (const m of line.text.matchAll(LINK_RE)) {
        const start = line.from + m.index!;
        const end = start + m[0].length;
        const target = m[2].trim();
        if (!target || plugins.embeds.has(extOf(target))) continue;
        const ext = extOf(target);
        const known = ext && ext !== "md" ? !!state.facet(editorHooks).resolveFile(target) : resolveHook(target);
        const cls = `cm-rn-wikilink${known ? "" : " cm-rn-unresolved"}`;
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

/**
 * Whole-block previews, unless the cursor is inside: ```lang fences and ![[file.ext]] embeds a plugin
 * claimed, attachments, embedded notes, tables and $$ math.
 */
function buildBlocks(state: EditorState): DecorationSet {
  const active = activeLines(state);
  const hooks = state.facet(editorHooks);
  const builder = new RangeSetBuilder<Decoration>();
  const doc = state.doc;
  const touched = (a: number, b: number) => {
    for (let k = a; k <= b; k++) if (active.has(k)) return true;
    return false;
  };
  const block = (from: number, to: number, widget: WidgetType) => builder.add(from, to, Decoration.replace({ widget, block: true }));
  const fmEnd = parseFrontmatter(state.sliceDoc(0, Math.min(doc.length, 8000))).end;
  for (let i = fmEnd ? doc.lineAt(fmEnd).number : 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    if (line.from < fmEnd) continue;
    const fence = /^(`{3,}|~{3,})\s*([\w-]*)/.exec(line.text);
    if (fence) {
      const close = new RegExp(`^${fence[1][0]}{${fence[1].length},}\\s*$`);
      let j = i + 1;
      while (j <= doc.lines && !close.test(doc.line(j).text)) j++;
      if (j > doc.lines) break;
      const lang = fence[2].toLowerCase();
      if (lang && plugins.blocks.has(lang) && !touched(i, j)) {
        const end = doc.line(j);
        const source = doc.sliceString(line.to + 1, end.from).trim();
        const file = plugins.blocks.get(lang)!.sourceFile?.(source);
        block(line.from, end.to, new PluginWidget("block", lang, source, plugins.version, file ? hooks.resolveFile(file)?.version ?? -1 : 0));
      }
      i = j;
      continue;
    }
    const html = HTML_OPEN.exec(line.text);
    if (html) {
      const j = htmlEnd(doc, i, html[1].toLowerCase());
      if (!touched(i, j)) block(line.from, doc.line(j).to, new HtmlWidget(dedent(doc.sliceString(line.from, doc.line(j).to)), line.from));
      i = j;
      continue;
    }
    if (/^\s*\$\$/.test(line.text)) {
      const one = /^\s*\$\$(.+)\$\$\s*$/.exec(line.text);
      let j = i;
      if (!one) {
        j = i + 1;
        while (j <= doc.lines && !/\$\$\s*$/.test(doc.line(j).text)) j++;
        if (j > doc.lines) continue;
      }
      const end = doc.line(j);
      const tex = one ? one[1] : doc.sliceString(line.from, end.to).trim().slice(2, -2);
      if (!touched(i, j)) block(line.from, end.to, new MathWidget(tex.trim(), true));
      i = j;
      continue;
    }
    if (line.text.includes("|") && i < doc.lines && TABLE_DELIM.test(doc.line(i + 1).text) && doc.line(i + 1).text.includes("-")) {
      let j = i + 1;
      while (j + 1 <= doc.lines && doc.line(j + 1).text.includes("|") && doc.line(j + 1).text.trim()) j++;
      if (!touched(i, j)) block(line.from, doc.line(j).to, new TableWidget(doc.sliceString(line.from, doc.line(j).to)));
      i = j;
      continue;
    }
    if (active.has(i)) continue;
    const embed = /^\s*!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]\s*$/.exec(line.text);
    if (embed) {
      const target = embed[1].trim();
      const ext = extOf(target);
      if (plugins.embeds.has(ext)) block(line.from, line.to, new PluginWidget("embed", ext, target, plugins.version, hooks.resolveFile(target)?.version ?? -1));
      else if (isMedia(ext)) {
        const hit = hooks.resolveFile(target);
        block(line.from, line.to, new MediaWidget(target, hit?.path ?? null, hit?.version ?? 0, embed[2]?.trim() ?? "", line.from));
      } else if (!ext || ext === "md") {
        const [name, heading] = target.split("#");
        const path = name ? hooks.resolveNote(name) : hooks.notePath;
        const content = path ? hooks.noteContent(path) : null;
        if (path && content != null && path !== hooks.notePath) block(line.from, line.to, new NoteEmbedWidget(target, path, heading ? section(content, heading) : content));
      }
      continue;
    }
    const img = /^\s*!\[([^\]]*)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)\s*$/.exec(line.text);
    if (img) {
      const [alt, size = ""] = img[1].split("|");
      const external = /^https?:/.test(img[2]);
      const hit = external ? { path: img[2], version: 0 } : hooks.resolveFile(decodeURI(img[2]));
      if (external || isMedia(extOf(img[2]))) block(line.from, line.to, new MediaWidget(alt || img[2], hit?.path ?? null, hit?.version ?? 0, size.trim(), line.from));
    }
  }
  return builder.finish();
}

export const blockPreview = StateField.define<DecorationSet>({
  create: buildBlocks,
  update(deco, tr) {
    return tr.docChanged || tr.selection || tr.effects.some((e) => e.is(refreshPreview)) ? buildBlocks(tr.state) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
