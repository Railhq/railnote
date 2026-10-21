import { available } from "@canviz-engine";
import type { BuiltinPlugin, RenderInfo } from "../api";
import { parseExplainer } from "./check";
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
export async function loadExplainer(source: string, read: (src: string) => Promise<string>): Promise<{ data: DiagramData; opts: PlayerOptions }> {
  const text = source.trim();
  if (text.startsWith("{")) return { data: parseExplainer(text, "The explainer"), opts: {} };
  const spec: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^(\w+):\s*(.*)$/.exec(line.trim());
    if (m) spec[m[1]] = m[2].trim();
  }
  if (!spec.src) throw new Error("block needs a `src:` path or inline JSON");
  const flag = (k: string) => (spec[k] === undefined ? undefined : spec[k] === "true");
  const opts: PlayerOptions = { autoplay: flag("autoplay"), loop: flag("loop"), captions: flag("captions") };
  if (spec.speed) opts.speed = Number(spec.speed);
  const src = spec.src.replace(/^\[\[|\]\]$/g, "");
  return { data: parseExplainer(await read(src), src), opts };
}

/** Plays openCanviz explainers inline: ```canviz blocks and ![[file.canviz]] embeds. */
export const canvizPlugin: BuiltinPlugin = {
  id: "canviz",
  name: "Explainers",
  description: "Plays animated openCanviz explainers from ```canviz blocks and ![[file.canviz]] embeds.",
  activate(rn) {
    // Per explainer: the last version that played and where its playhead was, so an outside edit
    // redraws at the same moment, and a half-written or broken edit keeps the old one on screen.
    const lastGood = new Map<string, { data: DiagramData; opts: PlayerOptions }>();
    const playhead = new Map<string, number>();
    const play = async (source: string, el: HTMLElement, info: RenderInfo) => {
      if (!available) throw new Error("playback isn't included in this build");
      const key = `${info.notePath ?? ""}\n${sourceFile(source) ?? source}`;
      let loaded: { data: DiagramData; opts: PlayerOptions };
      let problem: string | null = null;
      try {
        loaded = await loadExplainer(source, rn.vault.read);
        lastGood.set(key, loaded);
      } catch (e) {
        const was = lastGood.get(key);
        if (!was) throw e;
        loaded = was;
        problem = (e as Error).message;
      }
      if (problem) {
        const note = document.createElement("div");
        note.className = "canviz-stale";
        note.textContent = `${problem}. Showing the last version that played.`;
        el.append(note);
      }
      const stage = el.appendChild(document.createElement("div"));
      const player = new CanvizPlayer(stage, loaded.data, loaded.opts);
      const at = playhead.get(key);
      if (at) void player.ready.then(() => player.seek(at));
      return () => {
        playhead.set(key, player.time);
        player.destroy();
      };
    };
    rn.registerBlock("canviz", (source, el, info) => {
      // The JSON lives in its own file, so edit that rather than the block's one line.
      const file = sourceFile(source);
      if (file) info.setEditFile(file);
      return play(source, el, info);
    }, { sourceFile });
    rn.registerEmbed(["canviz"], (target, el, info) => play(`src: ${target}`, el, info));
    rn.addCommand({
      id: "insert",
      label: "Insert explainer block",
      // The cursor lands inside, so the block stays as text until the path is filled in.
      run: () => rn.workspace.insertText("```canviz\nsrc: \n```\n", "```canviz\nsrc: ".length),
    });
  },
};
