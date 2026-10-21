// Full Markdown to HTML for a note: embeds, note embeds, callouts, math, highlights and footnotes,
// with Obsidian's syntax. Used for ![[note]] embeds in the editor and for HTML/PDF export.
// Attachments come out as data-rn-file="<vault path>" so each caller decides how they load.

import { Marked, type Tokens, type TokenizerExtension, type RendererExtension } from "marked";
import katex from "katex";
import { parseFrontmatter } from "./parse";
import { AUDIO_EXT, IMAGE_EXT, VIDEO_EXT, extOf } from "./vault-index";

export interface RenderOptions {
  resolveFile(src: string): string | null;
  resolveNote(target: string): string | null;
  noteContent(path: string): string | null;
  /** "mathml" needs no fonts, which suits a standalone export. */
  mathOutput?: "html" | "mathml" | "htmlAndMathml";
  /** How wikilinks between notes come out: live links in the app, plain text in an export. */
  links?: "app" | "text";
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CALLOUT_GROUP: Record<string, string> = {
  note: "note", info: "note", todo: "note",
  abstract: "tip", summary: "tip", tldr: "tip", tip: "tip", hint: "tip", important: "tip",
  success: "success", check: "success", done: "success",
  question: "question", help: "question", faq: "question",
  warning: "warning", caution: "warning", attention: "warning",
  failure: "danger", fail: "danger", missing: "danger", danger: "danger", error: "danger", bug: "danger",
  example: "example",
  quote: "quote", cite: "quote",
};
export const calloutGroup = (type: string) => CALLOUT_GROUP[type.toLowerCase()] ?? "note";
export const calloutTitle = (type: string) => type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();

export function renderMath(tex: string, display: boolean, output: RenderOptions["mathOutput"] = "htmlAndMathml") {
  return katex.renderToString(tex, { displayMode: display, throwOnError: false, output });
}

/** The lines under a heading, up to the next heading of the same or higher level. */
export function section(content: string, heading: string): string {
  const lines = content.split("\n");
  const want = heading.trim().toLowerCase();
  const start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s+/, "").trim().toLowerCase() === want);
  if (start < 0) return "";
  const level = /^#+/.exec(lines[start])![0].length;
  let end = start + 1;
  while (end < lines.length && !(new RegExp(`^#{1,${level}}\\s`).test(lines[end]))) end++;
  return lines.slice(start, end).join("\n");
}

/** HTML for an attachment the vault has at `path`. */
export function mediaTag(path: string, alt: string, size?: string): string {
  const ext = extOf(path);
  const [w, h] = (size ?? "").split("x").map((n) => (/^\d+$/.test(n) ? n : ""));
  const dims = `${w ? ` width="${w}"` : ""}${h ? ` height="${h}"` : ""}`;
  const file = `data-rn-file="${esc(path)}"`;
  if (IMAGE_EXT.has(ext)) return `<img ${file} alt="${esc(alt)}"${dims}>`;
  if (AUDIO_EXT.has(ext)) return `<audio controls ${file}></audio>`;
  if (VIDEO_EXT.has(ext)) return `<video controls ${file}${dims}></video>`;
  if (ext === "pdf") return `<iframe class="rn-pdf" ${file} title="${esc(alt)}"></iframe>`;
  return `<a class="rn-attachment" ${file}>${esc(alt)}</a>`;
}

export function renderNote(src: string, opts: RenderOptions, depth = 0): string {
  const body = src.slice(parseFrontmatter(src).end);
  const mathOut = opts.mathOutput ?? "htmlAndMathml";

  // Footnotes: one-line definitions anywhere in the note, numbered in order of first reference.
  const defs = new Map<string, string>();
  const text = body.replace(/^\[\^([^\]\s]+)\]:[ \t]*(.*)$/gm, (_m, id: string, def: string) => {
    defs.set(id, def);
    return "";
  });
  const order: string[] = [];

  const wikilink: TokenizerExtension & RendererExtension = {
    name: "wikilink",
    level: "inline",
    start: (s) => s.match(/!?\[\[/)?.index,
    tokenizer(s) {
      const m = /^(!?)\[\[([^\]|#\n]*)(#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/.exec(s);
      if (!m) return;
      return { type: "wikilink", raw: m[0], embed: m[1] === "!", target: m[2].trim(), heading: m[3]?.slice(1), alias: m[4] };
    },
    renderer(t) {
      const { embed, target, heading, alias } = t as unknown as { embed: boolean; target: string; heading?: string; alias?: string };
      const ext = extOf(target);
      if (embed && ext && ext !== "md") {
        if (ext === "canviz") return `<div class="rn-explainer" data-src="${esc(target)}"></div>`;
        const path = opts.resolveFile(target);
        if (!path) return `<span class="rn-missing">${esc(target)}</span>`;
        return mediaTag(path, target, alias);
      }
      const notePath = target ? opts.resolveNote(target) : null;
      if (embed && notePath && depth < 2) {
        const content = opts.noteContent(notePath) ?? "";
        const part = heading ? section(content, heading) : content;
        return `<div class="rn-embed-note"><div class="rn-embed-name">${esc(target.replace(/^.*\//, ""))}${heading ? ` › ${esc(heading)}` : ""}</div>${renderNote(part, opts, depth + 1)}</div>`;
      }
      const label = esc(alias ?? (target.replace(/^.*\//, "") + (heading ? ` › ${heading}` : "")));
      if (opts.links === "text") return `<span class="rn-link">${label}</span>`;
      return `<a class="rn-link${notePath ? "" : " unresolved"}" data-link="${esc(target + (heading ? "#" + heading : ""))}">${label}</a>`;
    },
  };

  const highlight: TokenizerExtension & RendererExtension = {
    name: "highlight",
    level: "inline",
    start: (s) => s.indexOf("=="),
    tokenizer(s) {
      const m = /^==(?=\S)([^=\n]*?\S)==/.exec(s);
      if (m) return { type: "highlight", raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
    },
    renderer(t) {
      return `<mark>${this.parser.parseInline((t as Tokens.Generic).tokens!)}</mark>`;
    },
  };

  const mathInline: TokenizerExtension & RendererExtension = {
    name: "mathInline",
    level: "inline",
    start: (s) => s.indexOf("$"),
    tokenizer(s) {
      const m = /^\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/.exec(s);
      if (m) return { type: "mathInline", raw: m[0], tex: m[1] };
    },
    renderer: (t) => renderMath((t as unknown as { tex: string }).tex, false, mathOut),
  };

  const mathBlock: TokenizerExtension & RendererExtension = {
    name: "mathBlock",
    level: "block",
    start: (s) => s.match(/^\$\$/m)?.index,
    tokenizer(s) {
      const m = /^\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/.exec(s);
      if (m) return { type: "mathBlock", raw: m[0], tex: m[1].trim() };
    },
    renderer: (t) => `<div class="rn-math">${renderMath((t as unknown as { tex: string }).tex, true, mathOut)}</div>`,
  };

  const footnoteRef: TokenizerExtension & RendererExtension = {
    name: "footnoteRef",
    level: "inline",
    start: (s) => s.indexOf("[^"),
    tokenizer(s) {
      const m = /^\[\^([^\]\s]+)\]/.exec(s);
      if (m && defs.has(m[1])) return { type: "footnoteRef", raw: m[0], id: m[1] };
    },
    renderer(t) {
      const id = (t as unknown as { id: string }).id;
      if (!order.includes(id)) order.push(id);
      const n = order.indexOf(id) + 1;
      return `<sup class="rn-fn-ref"><a href="#fn-${esc(id)}" title="${esc(defs.get(id) ?? "")}">${n}</a></sup>`;
    },
  };

  const callout: TokenizerExtension & RendererExtension = {
    name: "callout",
    level: "block",
    start: (s) => s.match(/^>\s*\[!/m)?.index,
    tokenizer(s) {
      const m = /^(?:>[^\n]*(?:\n|$))+/.exec(s);
      if (!m) return;
      const lines = m[0].replace(/\n$/, "").split("\n").map((l) => l.replace(/^>\s?/, ""));
      const head = /^\[!([\w-]+)\][+-]?\s*(.*)$/.exec(lines[0]);
      if (!head) return;
      return {
        type: "callout",
        raw: m[0],
        kind: head[1],
        title: this.lexer.inlineTokens(head[2] || calloutTitle(head[1])),
        tokens: this.lexer.blockTokens(lines.slice(1).join("\n")),
      };
    },
    renderer(t) {
      const c = t as unknown as { kind: string; title: Tokens.Generic["tokens"]; tokens: Tokens.Generic["tokens"] };
      return `<div class="rn-callout rn-co-${calloutGroup(c.kind)}"><div class="rn-callout-title">${this.parser.parseInline(c.title!)}</div><div class="rn-callout-body">${this.parser.parse(c.tokens!)}</div></div>`;
    },
  };

  const marked = new Marked({
    gfm: true,
    extensions: [callout, mathBlock, wikilink, highlight, mathInline, footnoteRef],
    renderer: {
      code({ text, lang }) {
        const l = (lang ?? "").trim().toLowerCase();
        if (l === "mermaid") return `<div class="rn-mermaid" data-code="${esc(text)}"></div>`;
        if (l === "canviz") return `<div class="rn-explainer" data-canviz="${esc(text)}"></div>`;
        return `<pre><code${l ? ` class="language-${esc(l)}"` : ""}>${esc(text)}</code></pre>`;
      },
      image({ href, text }) {
        if (/^(https?:|data:)/.test(href)) return `<img src="${esc(href)}" alt="${esc(text)}">`;
        const [alt, size] = text.split("|");
        const path = opts.resolveFile(decodeURI(href));
        return path ? mediaTag(path, alt, size) : `<span class="rn-missing">${esc(href)}</span>`;
      },
      link({ href, tokens }) {
        const inner = this.parser.parseInline(tokens);
        return /^https?:/.test(href) ? `<a class="rn-ext" href="${esc(href)}" data-href="${esc(href)}">${inner}</a>` : inner;
      },
    },
  });

  let html = marked.parse(text, { async: false }) as string;
  if (order.length)
    html += `<section class="rn-footnotes"><ol>${order.map((id) => `<li id="fn-${esc(id)}">${marked.parseInline(defs.get(id) ?? "", { async: false })}</li>`).join("")}</ol></section>`;
  return html;
}
