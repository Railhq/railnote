import type { BuiltinPlugin } from "./api";

let seq = 0;
let ready: Promise<typeof import("mermaid").default> | null = null;

/** Mermaid is large, so it loads the first time a note has a diagram. */
function load() {
  ready ??= import("mermaid").then(({ default: mermaid }) => {
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "neutral", fontFamily: "Hanken Grotesk Variable, sans-serif" });
    return mermaid;
  });
  return ready;
}

/** Turns Mermaid source into an SVG string. Also used by export. */
export async function mermaidSvg(code: string): Promise<string> {
  const mermaid = await load();
  const { svg } = await mermaid.render(`rn-mermaid-${++seq}`, code);
  return svg;
}

/** Draws ```mermaid blocks: flowcharts, sequence diagrams, Gantt charts and the rest. */
export const mermaidPlugin: BuiltinPlugin = {
  id: "diagrams",
  name: "Diagrams",
  description: "Draws ```mermaid blocks: flowcharts, sequence diagrams, timelines and more.",
  activate(rn) {
    rn.registerBlock("mermaid", async (source, el) => {
      el.classList.add("rn-mermaid");
      el.innerHTML = await mermaidSvg(source);
    });
    rn.addCommand({
      id: "insert",
      label: "Insert diagram",
      run: () => rn.workspace.insertText("```mermaid\nflowchart LR\n  A --> B\n```\n", "```mermaid\n".length),
    });
  },
};
