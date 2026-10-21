// Plain-language checks on an explainer file, so a broken edit says what to fix instead of
// showing a parser error or a blank stage.

import type { DiagramData } from "./player";

/** Parses an explainer's JSON, naming the line and column of a syntax error. */
export function parseExplainer(text: string, where: string): DiagramData {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    const msg = (e as Error).message;
    const pos = /position (\d+)/.exec(msg);
    if (pos) {
      const before = text.slice(0, Number(pos[1]));
      const line = before.split("\n").length;
      const col = Number(pos[1]) - before.lastIndexOf("\n");
      throw new Error(`${where} isn't valid JSON at line ${line}, column ${col}: ${msg.replace(/\s*(in JSON )?at position \d+.*$/, "")}`);
    }
    throw new Error(`${where} isn't valid JSON: ${msg}`);
  }
  const problems = checkExplainer(data);
  if (problems.length) {
    const more = problems.length > 3 ? ` (and ${problems.length - 3} more)` : "";
    throw new Error(`${where}: ${problems.slice(0, 3).join("; ")}${more}`);
  }
  return data as DiagramData;
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

/** What's wrong with a parsed explainer, as short sentences. Empty when it can play. */
export function checkExplainer(d: unknown): string[] {
  if (!isObj(d)) return ["the file should hold one JSON object with nodes, edges and steps"];
  // A multi-scene project: each scene is checked on its own, since node ids are per scene.
  if (d.diagrams !== undefined) {
    if (!Array.isArray(d.diagrams) || !d.diagrams.length) return ['"diagrams" should be a list of scenes'];
    return d.diagrams.flatMap((s: unknown, i: number) => checkScene(s).map((p) => `diagrams[${i}]: ${p}`));
  }
  return checkScene(d);
}

function checkScene(d: unknown): string[] {
  if (!isObj(d)) return ["a scene should be an object with nodes, edges and steps"];
  const out: string[] = [];
  for (const k of ["nodes", "edges", "steps"] as const)
    if (d[k] !== undefined && !Array.isArray(d[k])) out.push(`"${k}" should be a list`);
  if (out.length) return out;
  const ids = new Set<string>();
  const node = (n: unknown, at: string) => {
    if (!isObj(n)) return void out.push(`${at} should be an object`);
    if (typeof n.id !== "string" || !n.id) return void out.push(`${at} needs an "id"`);
    ids.add(n.id);
  };
  (d.nodes ?? []).forEach((n: unknown, i: number) => node(n, `nodes[${i}]`));
  const steps: unknown[] = d.steps ?? [];
  steps.forEach((s, i) => {
    if (!isObj(s)) return void out.push(`steps[${i}] should be an object`);
    if (s.durationMs !== undefined && !(typeof s.durationMs === "number" && s.durationMs >= 0)) out.push(`steps[${i}].durationMs should be a number of milliseconds`);
    if (s.nodes !== undefined && !Array.isArray(s.nodes)) out.push(`steps[${i}].nodes should be a list`);
    else (s.nodes ?? []).forEach((n: unknown, j: number) => node(n, `steps[${i}].nodes[${j}]`));
  });
  const edge = (e: unknown, at: string) => {
    if (!isObj(e)) return void out.push(`${at} should be an object`);
    for (const end of ["from", "to"] as const)
      if (typeof e[end] === "string" && !ids.has(e[end])) out.push(`${at}.${end} points at "${e[end]}", which no node is called`);
  };
  (d.edges ?? []).forEach((e: unknown, i: number) => edge(e, `edges[${i}]`));
  steps.forEach((s, i) => isObj(s) && Array.isArray(s.edges) && s.edges.forEach((e: unknown, j: number) => edge(e, `steps[${i}].edges[${j}]`)));
  if (!(d.nodes ?? []).length && !steps.some((s) => isObj(s) && (s.nodes ?? []).length)) out.push("there are no nodes to draw");
  return out;
}
