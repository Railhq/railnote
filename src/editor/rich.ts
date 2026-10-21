import { EditorView, WidgetType } from "@codemirror/view";
import { editorHooks, fileUrl, whereFrom } from "./hooks";
import { esc, renderMath, renderNote } from "../lib/render";
import { AUDIO_EXT, IMAGE_EXT, VIDEO_EXT, extOf, noteFolder } from "../lib/vault-index";

// Widgets the live preview swaps in for Markdown that reads better drawn: attachments, tables,
// math, footnote markers and embedded notes. Clicking one puts the cursor back in its source.

/** Clicks on rendered [[links]] and URLs inside a widget follow them; anything else is up to the widget. */
function followLinks(view: EditorView, e: MouseEvent): boolean {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-link], [data-href]");
  if (!el) return false;
  e.preventDefault();
  e.stopPropagation();
  const hooks = view.state.facet(editorHooks);
  if (el.dataset.link) hooks.openLink(el.dataset.link, whereFrom(e));
  else if (el.dataset.href) hooks.openUrl(el.dataset.href);
  return true;
}

/** Fills in src on every data-rn-file element a render produced. */
export function loadFiles(root: HTMLElement, view: EditorView) {
  const hooks = view.state.facet(editorHooks);
  for (const el of root.querySelectorAll<HTMLElement>("[data-rn-file]")) {
    const path = el.dataset.rnFile!;
    const hit = hooks.resolveFile(path);
    if (el instanceof HTMLAnchorElement) el.onclick = () => hooks.openInSystem(path);
    else el.setAttribute("src", fileUrl(path, hit?.version));
    if (el instanceof HTMLImageElement) el.onload = () => view.requestMeasure();
  }
}

export class MediaWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly path: string | null,
    readonly version: number,
    readonly size: string,
    readonly from: number,
  ) {
    super();
  }

  eq(o: MediaWidget) {
    return o.src === this.src && o.path === this.path && o.version === this.version && o.size === this.size;
  }

  get estimatedHeight() {
    const ext = extOf(this.path ?? "");
    return IMAGE_EXT.has(ext) || VIDEO_EXT.has(ext) ? 280 : ext === "pdf" ? 640 : 56;
  }

  toDOM(view: EditorView) {
    const hooks = view.state.facet(editorHooks);
    const wrap = document.createElement("div");
    wrap.className = "rn-media";
    if (!this.path) {
      wrap.classList.add("missing");
      wrap.textContent = `Couldn't find ${this.src} in this vault.`;
      wrap.onmousedown = (e) => {
        e.preventDefault();
        view.dispatch({ selection: { anchor: view.posAtDOM(wrap) } });
        view.focus();
      };
      return wrap;
    }
    const external = /^https?:/.test(this.path);
    const ext = external ? extOf(new URL(this.path).pathname) || "png" : extOf(this.path);
    const url = external ? this.path : fileUrl(this.path, this.version);
    const [w, h] = this.size.split("x").map((n) => (/^\d+$/.test(n) ? Number(n) : 0));
    let media: HTMLElement;
    if (IMAGE_EXT.has(ext)) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = this.src;
      img.draggable = false;
      if (w) img.width = w;
      if (h) img.height = h;
      img.onload = () => view.requestMeasure();
      img.onerror = () => {
        wrap.classList.add("missing");
        wrap.textContent = `Couldn't load ${this.src}.`;
      };
      media = img;
      // Clicking the picture puts the cursor on its line, which shows the ![[…]] to edit.
      img.onmousedown = (e) => {
        e.preventDefault();
        view.dispatch({ selection: { anchor: this.from } });
        view.focus();
      };
    } else if (AUDIO_EXT.has(ext) || VIDEO_EXT.has(ext)) {
      const m = document.createElement(AUDIO_EXT.has(ext) ? "audio" : "video");
      m.controls = true;
      m.preload = "metadata";
      m.src = url;
      if (w && m instanceof HTMLVideoElement) m.width = w;
      m.onloadedmetadata = () => view.requestMeasure();
      media = m;
    } else {
      const frame = document.createElement("iframe");
      frame.className = "rn-pdf";
      frame.src = url;
      frame.title = this.src;
      if (h) frame.style.height = `${h}px`;
      media = frame;
    }
    const open = document.createElement("button");
    open.className = "rn-media-open";
    open.textContent = "Open";
    open.title = external ? `Open ${this.path} in the browser` : `Open ${this.path} in its default app`;
    open.onclick = () => (external ? hooks.openUrl(this.path!) : hooks.openInSystem(this.path!));
    wrap.append(media, open);
    wrap.addEventListener("mousedown", (e) => e.stopPropagation());
    return wrap;
  }

  ignoreEvent() {
    return true;
  }
}

/** Splits "| a | b \| c |" into cells, keeping escaped pipes, with each cell's offset in the line. */
function cells(line: string): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = [];
  let start = 0;
  let i = 0;
  const lead = /^\s*\|/.exec(line);
  if (lead) start = i = lead[0].length;
  for (; i <= line.length; i++) {
    if (i < line.length && (line[i] !== "|" || line[i - 1] === "\\")) continue;
    const raw = line.slice(start, i);
    if (i < line.length || raw.trim()) out.push({ text: raw.trim().replace(/\\\|/g, "|"), at: start + raw.length - raw.trimStart().length });
    start = i + 1;
  }
  return out;
}

export const TABLE_DELIM = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

export class TableWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  eq(o: TableWidget) {
    return o.text === this.text;
  }

  get estimatedHeight() {
    return this.text.split("\n").length * 34;
  }

  toDOM(view: EditorView) {
    const lines = this.text.split("\n");
    const align = cells(lines[1]).map((c) => (c.text.startsWith(":") && c.text.endsWith(":") ? "center" : c.text.endsWith(":") ? "right" : ""));
    const hooks = view.state.facet(editorHooks);
    const opts = { resolveFile: (s: string) => hooks.resolveFile(s)?.path ?? null, resolveNote: hooks.resolveNote, noteContent: hooks.noteContent };
    const inline = (s: string) =>
      renderNote(s, opts)
        .trim()
        .replace(/^<p>([\s\S]*)<\/p>$/, "$1");
    let offset = 0;
    const rows: string[] = [];
    lines.forEach((line, r) => {
      if (r !== 1) {
        const tag = r === 0 ? "th" : "td";
        const tds = cells(line).map((c, k) => `<${tag} data-off="${offset + c.at}"${align[k] ? ` style="text-align:${align[k]}"` : ""}>${inline(c.text)}</${tag}>`);
        rows.push(`<tr>${tds.join("")}</tr>`);
        if (r === 0) rows.push("</thead><tbody>");
      }
      offset += line.length + 1;
    });
    const wrap = document.createElement("div");
    wrap.className = "rn-table";
    wrap.innerHTML = `<table><thead>${rows.join("")}</tbody></table>`;
    loadFiles(wrap, view);
    wrap.addEventListener("mousedown", (e) => {
      if (followLinks(view, e)) return;
      const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-off]");
      e.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(wrap) + Number(cell?.dataset.off ?? 0) } });
      view.focus();
    });
    return wrap;
  }

  ignoreEvent() {
    return true;
  }
}

export class MathWidget extends WidgetType {
  constructor(readonly tex: string, readonly display: boolean) {
    super();
  }

  eq(o: MathWidget) {
    return o.tex === this.tex && o.display === this.display;
  }

  toDOM() {
    const el = document.createElement(this.display ? "div" : "span");
    el.className = this.display ? "rn-math" : "rn-math-inline";
    el.innerHTML = renderMath(this.tex, this.display);
    return el;
  }

  // Let the click through: the editor puts the cursor here, which shows the TeX.
  ignoreEvent() {
    return false;
  }
}

export class FootnoteWidget extends WidgetType {
  constructor(readonly id: string, readonly def: string | undefined, readonly isDef: boolean) {
    super();
  }

  eq(o: FootnoteWidget) {
    return o.id === this.id && o.def === this.def && o.isDef === this.isDef;
  }

  toDOM() {
    const el = document.createElement("sup");
    el.className = this.isDef ? "rn-fn-def" : "rn-fn-ref";
    el.textContent = this.isDef ? `${this.id}.` : this.id;
    if (!this.isDef) el.title = this.def ?? "This footnote has no definition yet. Add a line like [^" + this.id + "]: text";
    if (!this.isDef && this.def === undefined) el.classList.add("unresolved");
    return el;
  }

  ignoreEvent() {
    return false;
  }
}

export class CalloutLabel extends WidgetType {
  constructor(readonly label: string) {
    super();
  }

  eq(o: CalloutLabel) {
    return o.label === this.label;
  }

  toDOM() {
    const el = document.createElement("span");
    el.className = "rn-callout-label";
    el.textContent = this.label;
    return el;
  }

  ignoreEvent() {
    return false;
  }
}

/** ![[Note]] or ![[Note#Heading]]: the other note's text, read-only, with a way to go there. */
export class NoteEmbedWidget extends WidgetType {
  constructor(readonly target: string, readonly path: string, readonly content: string) {
    super();
  }

  eq(o: NoteEmbedWidget) {
    return o.target === this.target && o.path === this.path && o.content === this.content;
  }

  get estimatedHeight() {
    return 160;
  }

  toDOM(view: EditorView) {
    const hooks = view.state.facet(editorHooks);
    const wrap = document.createElement("div");
    wrap.className = "rn-embed-note";
    const head = document.createElement("div");
    head.className = "rn-embed-name";
    const link = document.createElement("a");
    link.className = "rn-link";
    link.dataset.link = this.target;
    link.textContent = this.target.replace(/^.*\//, "").replace("#", " › ");
    head.append(link);
    const body = document.createElement("div");
    body.className = "rn-embed-body";
    // Attachments in the embedded note resolve from that note's folder.
    const folder = noteFolder(this.path);
    const resolveFile = (s: string) => hooks.resolveFile(s.includes("/") || !folder ? s : `${folder}/${s}`)?.path ?? hooks.resolveFile(s)?.path ?? null;
    body.innerHTML = this.content.trim() ? renderNote(this.content, { resolveFile, resolveNote: hooks.resolveNote, noteContent: hooks.noteContent }, 1) : `<p class="muted">${esc(this.target)} is empty.</p>`;
    loadFiles(body, view);
    wrap.append(head, body);
    wrap.addEventListener("mousedown", (e) => {
      if (followLinks(view, e)) return;
      e.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(wrap) } });
      view.focus();
    });
    return wrap;
  }

  ignoreEvent() {
    return true;
  }
}
