import { EditorView, WidgetType } from "@codemirror/view";
import { available } from "@canviz-engine";
import { CanvizPlayer, DiagramData, PlayerOptions } from "../canviz/player";

/** Set by the app: reads an explainer's JSON given the `src:` written in the note.
 *  The editor can mount (and start loading explainers) before the app installs the reader,
 *  so early reads wait for it instead of failing. */
let installReader!: (fn: (src: string) => Promise<string>) => void;
let readerReady = new Promise<(src: string) => Promise<string>>((r) => (installReader = r));
const readSource = async (src: string) => (await readerReady)(src);
export function setCanvizSourceReader(fn: (src: string) => Promise<string>) {
  installReader(fn);
  readerReady = Promise.resolve(fn);
}

/** Set by the app: opens the file behind a `src:` explainer for editing. */
let openSourceFile: ((src: string) => void) | null = null;
export function setCanvizFileOpener(fn: (src: string) => void) {
  openSourceFile = fn;
}

/** The file an explainer block points at, or null when its JSON is written inline. */
function sourceFile(source: string): string | null {
  const m = /^\s*src:\s*(.+?)\s*$/m.exec(source.trim().startsWith("{") ? "" : source);
  return m ? m[1].replace(/^\[\[|\]\]$/g, "") : null;
}

// ```canviz
// src: explainers/cdn.canviz
// autoplay: true
// ```
// or the DiagramData JSON inline.
export async function loadExplainer(source: string): Promise<{ data: DiagramData; opts: PlayerOptions }> {
  const text = source.trim();
  if (text.startsWith("{")) return { data: JSON.parse(text), opts: {} };
  const spec: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^(\w+):\s*(.*)$/.exec(line.trim());
    if (m) spec[m[1]] = m[2].trim();
  }
  if (!spec.src) throw new Error("block needs a `src:` path or inline JSON");
  const flag = (k: string) => (spec[k] === undefined ? undefined : spec[k] === "true");
  const opts: PlayerOptions = { autoplay: flag("autoplay"), loop: flag("loop"), captions: flag("captions") };
  if (spec.speed) opts.speed = Number(spec.speed);
  return { data: JSON.parse(await readSource(spec.src.replace(/^\[\[|\]\]$/g, ""))), opts };
}

const players = new WeakMap<HTMLElement, CanvizPlayer>();
const destroyed = new WeakSet<HTMLElement>();

export class CanvizWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }

  eq(o: CanvizWidget) {
    return o.source === this.source;
  }

  get estimatedHeight() {
    return 360;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "rn-canviz";
    // Clicks on the player must not move the editor cursor onto this line, or the block
    // flips back to source and the player is torn down mid-play. Inputs (the scrubber) still
    // need their default mousedown to drag.
    wrap.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
    });
    const edit = document.createElement("button");
    edit.className = "rn-canviz-edit";
    edit.textContent = "Edit source";
    const file = sourceFile(this.source);
    if (file) edit.title = `Open ${file}`;
    edit.onclick = () => {
      // The JSON lives in its own file, so edit that rather than the one-line embed.
      if (file && openSourceFile) return openSourceFile(file);
      const pos = view.posAtDOM(wrap);
      view.dispatch({ selection: { anchor: pos } });
      view.focus();
    };
    wrap.appendChild(edit);
    const body = document.createElement("div");
    wrap.appendChild(body);
    if (!available) {
      body.className = "rn-canviz-error";
      body.textContent = "Explainer playback isn't included in this build.";
      return wrap;
    }
    loadExplainer(this.source)
      .then(({ data, opts }) => {
        if (destroyed.has(wrap)) return;
        players.set(wrap, new CanvizPlayer(body, data, opts));
        // Height changes once the player lays out; let the editor re-measure.
        requestAnimationFrame(() => view.requestMeasure());
      })
      .catch((e) => {
        body.className = "rn-canviz-error";
        body.textContent = `Explainer: ${(e as Error).message}`;
      });
    return wrap;
  }

  destroy(dom: HTMLElement) {
    destroyed.add(dom);
    players.get(dom)?.destroy();
  }

  ignoreEvent() {
    return true;
  }
}
