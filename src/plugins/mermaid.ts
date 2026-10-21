import type { BuiltinPlugin } from "./api";

let seq = 0;
let ready: Promise<typeof import("mermaid").default> | null = null;

const config = (theme: "dark" | "neutral") => ({ startOnLoad: false, securityLevel: "strict" as const, theme, fontFamily: "Hanken Grotesk Variable, sans-serif" });
const appTheme = () => (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "neutral");

/** Mermaid is large, so it loads the first time a note has a diagram. */
function load() {
  ready ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize(config(appTheme()));
    return mermaid;
  });
  return ready;
}

/** Turns Mermaid source into an SVG string. Export asks for "light", since its page is paper whatever the app shows. */
export async function mermaidSvg(code: string, look: "app" | "light" = "app"): Promise<string> {
  const mermaid = await load();
  const theme = look === "light" ? "neutral" : appTheme();
  if (theme !== appTheme()) mermaid.initialize(config(theme));
  try {
    const { svg } = await mermaid.render(`rn-mermaid-${++seq}`, code);
    return svg;
  } finally {
    if (theme !== appTheme()) mermaid.initialize(config(appTheme()));
  }
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
