// Turns a note into one self-contained HTML page: attachments, fonts and diagrams inlined, and
// explainers playing through a bundled copy of the player. The same page is printed for PDF.

import css from "./page.css?raw";
import { cleanHtml, esc, renderNote } from "../lib/render";
import { AUDIO_EXT, IMAGE_EXT, VIDEO_EXT, extOf, fileName, noteFolder } from "../lib/vault-index";
import { mermaidSvg } from "../plugins/mermaid";
import { loadExplainer } from "../plugins/canviz";
import { host, type Workspace } from "../workspace";

export type ExportKind = "html" | "pdf";

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  avif: "image/avif", bmp: "image/bmp", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg",
  flac: "audio/flac", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", ogv: "video/ogg",
};

// The hand pictures the engine draws with. Only inlined for explainers that use a hand, since they're most of a megabyte.
const HANDS = ["write-photoreal.png", "write-render3d.png", "carry-render3d.png", "carry-pinch.png", "carry-hook.png"];

/** `</script>` inside JSON would end the tag early. */
const scriptSafe = (json: string) => json.replace(/</g, "\\u003c");

export async function buildExport(ws: Workspace, path: string, kind: ExportKind): Promise<string> {
  const note = ws.index.notes.get(path);
  if (!note) throw new Error(`${path} isn't in this vault.`);
  const folder = noteFolder(path);
  const resolveFile = (s: string) => ws.index.resolveFile(s, folder);
  const body = renderNote(note.content, {
    resolveFile,
    resolveNote: (t) => ws.index.resolve(t),
    noteContent: (n) => ws.index.notes.get(n)?.content ?? null,
    mathOutput: "mathml",
    links: "text",
  });
  const doc = document.createElement("template");
  doc.innerHTML = body;
  const root = doc.content;
  cleanHtml(root);
  // Most notes open with their own name as a heading; the page header already shows it.
  const first = root.firstElementChild;
  if (first?.tagName === "H1" && first.textContent?.trim() === note.name) first.remove();

  // Attachments: pictures, audio and video go in as data; anything else is named, since a page can't carry it.
  await Promise.all(
    [...root.querySelectorAll<HTMLElement>("[data-rn-file]")].map(async (el) => {
      const file = el.dataset.rnFile!;
      el.removeAttribute("data-rn-file");
      const ext = extOf(file);
      if (!(IMAGE_EXT.has(ext) || AUDIO_EXT.has(ext) || VIDEO_EXT.has(ext)) || el instanceof HTMLIFrameElement || el instanceof HTMLAnchorElement) {
        const span = document.createElement("span");
        span.className = "rn-attachment";
        span.textContent = `Attachment: ${fileName(file)}`;
        el.replaceWith(span);
        return;
      }
      try {
        el.setAttribute("src", `data:${MIME[ext] ?? "application/octet-stream"};base64,${await host.readBase64(file)}`);
      } catch {
        el.outerHTML = `<span class="rn-missing">${esc(fileName(file))}</span>`;
      }
    }),
  );

  for (const el of root.querySelectorAll<HTMLElement>(".rn-mermaid")) {
    const code = el.dataset.code ?? "";
    el.removeAttribute("data-code");
    try {
      el.innerHTML = await mermaidSvg(code, "light");
    } catch {
      el.outerHTML = `<pre><code>${esc(code)}</code></pre>`;
    }
  }

  const explainers = [...root.querySelectorAll<HTMLElement>(".rn-explainer")];
  const player = explainers.length ? await host.exportAsset("player.js") : null;
  let usesHands = false;
  for (const el of explainers) {
    const source = el.dataset.canviz ?? `src: ${el.dataset.src}`;
    el.removeAttribute("data-canviz");
    el.removeAttribute("data-src");
    if (!player) {
      el.innerHTML = `<div class="rn-explainer-note">This explainer plays in Railnote.</div>`;
      continue;
    }
    try {
      const spec = await loadExplainer(source, (src) => host.readRaw(resolveFile(src) ?? src));
      const json = JSON.stringify(spec);
      if (/"hand/i.test(json)) usesHands = true;
      el.innerHTML = `<script type="application/json">${scriptSafe(json)}</script>`;
    } catch (e) {
      el.innerHTML = `<div class="rn-explainer-note">This explainer couldn't be exported: ${esc((e as Error).message)}</div>`;
    }
  }
  const playing = player && root.querySelector(".rn-explainer script");

  let hands = "";
  if (playing && usesHands) {
    const entries = await Promise.all(HANDS.map(async (f) => [f, await host.exportAsset(f)] as const));
    const map = Object.fromEntries(entries.filter(([, b]) => b).map(([f, b]) => [f, `data:image/png;base64,${b}`]));
    hands = `<script>window.__HAND_ASSET_URIS=${scriptSafe(JSON.stringify(map))}</script>`;
  }

  const holder = document.createElement("div");
  holder.append(root);
  const title = esc(note.name);
  const date = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const face = async (family: string, file: string, weight: string) => {
    const b = await host.exportAsset(file);
    return b ? `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};src:url(data:font/woff2;base64,${b}) format("woff2")}` : "";
  };
  const fonts = (await face("Literata", "literata-latin-opsz-normal.woff2", "200 900")) + (await face("Hanken Grotesk", "hanken-grotesk-latin-wght-normal.woff2", "100 900"));
  // Printing can't play, so each explainer shows its last frame, where the whole picture is built.
  const ready = playing
    ? `${hands}<script>${new TextDecoder().decode(Uint8Array.from(atob(player!), (c) => c.charCodeAt(0)))}</script>`
    : `<script>window.__railnoteReady=true</script>`;

  return `<!doctype html>
<html lang="en"${kind === "pdf" ? ' data-still="end"' : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Railnote">
<title>${title}</title>
<style>${fonts}${css}</style>
</head>
<body>
<main>
<header>${note.folder ? `<p class="crumb">${esc(note.folder)}</p>` : ""}<h1>${title}</h1><div class="rule"></div></header>
<article>${holder.innerHTML}</article>
<footer>Exported from Railnote on ${esc(date)}</footer>
</main>
${ready}
</body>
</html>
`;
}

/** Exports a note and saves it where the person picks. Resolves false if they cancel. */
export async function exportNote(ws: Workspace, path: string, kind: ExportKind): Promise<boolean> {
  const html = await buildExport(ws, path, kind);
  return host.saveExport(ws.index.notes.get(path)?.name ?? "Note", kind, html);
}
