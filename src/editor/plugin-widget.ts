import { EditorView, WidgetType } from "@codemirror/view";
import type { Cleanup, RenderInfo } from "../plugins/api";
import { plugins } from "../plugins/host";
import { editorHooks } from "./hooks";

const cleanups = new WeakMap<HTMLElement, Cleanup>();
const destroyed = new WeakSet<HTMLElement>();

/** A ```lang block or ![[file.ext]] embed drawn by whichever plugin claimed it. */
export class PluginWidget extends WidgetType {
  constructor(
    readonly kind: "block" | "embed",
    /** The block's language or the embed's extension. */
    readonly key: string,
    /** The block's text, or the embed's file name. */
    readonly source: string,
    readonly version: number,
    /** Counter of the file the widget draws from; it changes when an outside edit lands. */
    readonly fileVersion = 0,
  ) {
    super();
  }

  eq(o: PluginWidget) {
    return o.kind === this.kind && o.key === this.key && o.source === this.source && o.version === this.version && o.fileVersion === this.fileVersion;
  }

  get estimatedHeight() {
    return 360;
  }

  toDOM(view: EditorView) {
    const owner = (this.kind === "block" ? plugins.blocks : plugins.embeds).get(this.key);
    const wrap = document.createElement("div");
    wrap.className = `rn-block rn-block-${owner?.plugin ?? "none"}`;
    // Clicks inside must not move the editor cursor onto this line, or the block flips back to
    // source and whatever the plugin drew is torn down mid-use. Inputs still need their default.
    wrap.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement)) e.preventDefault();
    });
    // An embed's source is its file; a block's is its own text unless the plugin points elsewhere.
    let editFile: string | null = this.kind === "embed" ? this.source : null;
    const edit = document.createElement("button");
    edit.className = "rn-block-edit";
    edit.textContent = "Edit source";
    edit.onclick = async () => {
      if (editFile) {
        const app = await plugins.app();
        try {
          app.openFile(await app.resolve(editFile));
        } catch (e) {
          app.notice((e as Error).message);
        }
        return;
      }
      view.dispatch({ selection: { anchor: view.posAtDOM(wrap) } });
      view.focus();
    };
    const body = document.createElement("div");
    wrap.append(edit, body);
    const fail = (msg: string) => {
      body.className = "rn-block-error";
      body.textContent = msg;
    };
    if (!owner) {
      fail(this.kind === "block" ? `No plugin draws \`${this.key}\` blocks.` : `No plugin opens .${this.key} files.`);
      return wrap;
    }
    if (editFile) edit.title = `Open ${editFile}`;
    const info: RenderInfo = {
      notePath: view.state.facet(editorHooks).notePath || null,
      setEditFile: (src) => {
        editFile = src;
        edit.title = `Open ${src}`;
      },
      requestMeasure: () => view.requestMeasure(),
    };
    plugins
      .app()
      .then(() => owner.fn(this.source, body, info))
      .then((cleanup) => {
        if (!cleanup) return;
        if (destroyed.has(wrap)) cleanup();
        else cleanups.set(wrap, cleanup);
      })
      .catch((e) => fail(`${owner.name}: ${(e as Error).message}`))
      // Height changes once the plugin lays out; let the editor re-measure.
      .finally(() => requestAnimationFrame(() => view.requestMeasure()));
    return wrap;
  }

  destroy(dom: HTMLElement) {
    destroyed.add(dom);
    cleanups.get(dom)?.();
    cleanups.delete(dom);
  }

  ignoreEvent() {
    return true;
  }
}
