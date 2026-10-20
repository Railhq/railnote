import { available } from "@canviz-engine";
import type { BuiltinPlugin } from "../api";
import { CanvizPlayer, DiagramData, PlayerOptions } from "./player";

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
async function loadExplainer(source: string, read: (src: string) => Promise<string>): Promise<{ data: DiagramData; opts: PlayerOptions }> {
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
  return { data: JSON.parse(await read(spec.src.replace(/^\[\[|\]\]$/g, ""))), opts };
}

/** Plays openCanviz explainers inline: ```canviz blocks and ![[file.canviz]] embeds. */
export const canvizPlugin: BuiltinPlugin = {
  id: "canviz",
  name: "Explainers",
  description: "Plays animated openCanviz explainers from ```canviz blocks and ![[file.canviz]] embeds.",
  activate(rn) {
    const play = async (source: string, el: HTMLElement) => {
      if (!available) throw new Error("playback isn't included in this build");
      const { data, opts } = await loadExplainer(source, rn.vault.read);
      const player = new CanvizPlayer(el, data, opts);
      return () => player.destroy();
    };
    rn.registerBlock("canviz", (source, el, info) => {
      // The JSON lives in its own file, so edit that rather than the block's one line.
      const file = sourceFile(source);
      if (file) info.setEditFile(file);
      return play(source, el);
    });
    rn.registerEmbed(["canviz"], (target, el) => play(`src: ${target}`, el));
    rn.addCommand({
      id: "insert",
      label: "Insert explainer block",
      // The cursor lands inside, so the block stays as text until the path is filled in.
      run: () => rn.workspace.insertText("```canviz\nsrc: \n```\n", "```canviz\nsrc: ".length),
    });
  },
};
