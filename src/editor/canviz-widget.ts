import { EditorView, WidgetType } from "@codemirror/view";
import { available } from "@canviz-engine";
import { CanvizPlayer, DiagramData, PlayerOptions } from "../canviz/player";

/** Set by the app: reads an explainer's JSON given the `src:` written in the note. */
let readSource: (src: string) => Promise<string> = async () => {
  throw new Error("no vault open");
};
export function setCanvizSourceReader(fn: (src: string) => Promise<string>) {
  readSource = fn;
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
    const edit = document.createElement("button");
    edit.className = "rn-canviz-edit";
    edit.textContent = "Edit source";
    edit.onclick = () => {
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
