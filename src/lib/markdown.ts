// Minimal Markdown to HTML for read-only surfaces (Ask answers). Escapes first, so model output can't inject markup.

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One line of Markdown as HTML: emphasis, code, [[links]] and web links. */
export function renderInline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_m, target: string, heading: string | undefined, label: string | undefined) =>
      `<a class="rn-link" data-link="${target.trim()}${heading ?? ""}">${label ?? target.trim().replace(/^.*\//, "")}</a>`)
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a class="rn-ext" data-href="$2">$1</a>');
}

export function renderMarkdown(src: string): string {
  const out: string[] = [];
  const lines = src.split("\n");
  let list: "ul" | "ol" | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(renderInline).join("<br>")}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flushPara();
      closeList();
      const body: string[] = [];
      while (++i < lines.length && !/^```/.test(lines[i])) body.push(lines[i]);
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      closeList();
      out.push(`<h${h[1].length + 2}>${renderInline(h[2])}</h${h[1].length + 2}>`);
    } else if (ul || ol) {
      flushPara();
      const kind = ul ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${renderInline((ul ?? ol)![1])}</li>`);
    } else if (!line.trim()) {
      flushPara();
      closeList();
    } else {
      closeList();
      para.push(line);
    }
  }
  flushPara();
  closeList();
  return out.join("\n");
}
