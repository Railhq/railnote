// The link graph: which notes point at which, and a small force layout to draw it.

import type { VaultIndex } from "./vault-index";

export interface GraphNode {
  id: string;
  name: string;
  /** Top-level folder, "" for the vault root. Picks the node's colour, as in the sidebar. */
  group: string;
  degree: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Held in place while dragged. */
  fixed?: boolean;
}

export interface Graph {
  nodes: GraphNode[];
  edges: [number, number][];
  /** Top-level folders in sidebar order. */
  groups: string[];
}

export interface GraphQuery {
  /** Only this note and what's within `depth` links of it, either direction. */
  around?: string | null;
  depth?: number;
  /** Notes with no links at all. Left out of the whole-vault graph unless asked for. */
  orphans?: boolean;
}

const topFolder = (path: string) => (path.includes("/") ? path.slice(0, path.indexOf("/")) : "");

export function buildGraph(index: VaultIndex, q: GraphQuery = {}, previous?: Graph): Graph {
  const notes = index.all();
  const pairs = new Set<string>();
  const adj = new Map<string, Set<string>>();
  for (const n of notes) adj.set(n.path, new Set());
  for (const n of notes) {
    for (const l of n.parsed.links) {
      const to = index.resolve(l.target);
      if (!to || to === n.path || !adj.has(to)) continue;
      adj.get(n.path)!.add(to);
      adj.get(to)!.add(n.path);
      pairs.add(n.path < to ? `${n.path}\n${to}` : `${to}\n${n.path}`);
    }
  }

  let keep: Set<string>;
  if (q.around && adj.has(q.around)) {
    keep = new Set([q.around]);
    let frontier = [q.around];
    for (let d = 0; d < (q.depth ?? 1); d++) {
      const next: string[] = [];
      for (const p of frontier) for (const o of adj.get(p)!) if (!keep.has(o)) (keep.add(o), next.push(o));
      frontier = next;
    }
  } else {
    keep = new Set(notes.filter((n) => q.orphans || adj.get(n.path)!.size > 0).map((n) => n.path));
  }

  // Keep positions from the last build so the picture doesn't jump when a note changes.
  const old = new Map(previous?.nodes.map((n) => [n.id, n]));
  const kept = notes.filter((n) => keep.has(n.path));
  const nodes: GraphNode[] = kept.map((n, i) => {
    const o = old.get(n.path);
    // New nodes start on a spiral, which settles faster than random scatter.
    const a = i * 2.39996, r = 12 * Math.sqrt(i + 1);
    return {
      id: n.path,
      name: n.name,
      group: topFolder(n.path),
      degree: adj.get(n.path)!.size,
      x: o?.x ?? Math.cos(a) * r,
      y: o?.y ?? Math.sin(a) * r,
      vx: 0,
      vy: 0,
    };
  });
  const at = new Map(nodes.map((n, i) => [n.id, i]));
  const edges: [number, number][] = [];
  for (const p of pairs) {
    const [a, b] = p.split("\n");
    if (at.has(a) && at.has(b)) edges.push([at.get(a)!, at.get(b)!]);
  }
  const groups = [...new Set(notes.map((n) => topFolder(n.path)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return { nodes, edges, groups };
}

/** One step of the layout. `alpha` cools from 1 toward 0; returns how much the nodes moved. */
export function tick(g: Graph, alpha: number): number {
  const { nodes, edges } = g;
  const n = nodes.length;
  if (!n) return 0;
  const repel = 900 * alpha;
  // Past a couple of thousand notes, each node pushes against a sample instead of every other.
  const stride = n > 1500 ? Math.ceil(n / 1500) : 1;
  for (let i = 0; i < n; i++) {
    const a = nodes[i];
    for (let j = i + 1 + ((i * 7) % stride); j < n; j += stride) {
      const b = nodes[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.5; }
      if (d2 > 250000) continue;
      const f = (repel * stride) / d2;
      a.vx += dx * f; a.vy += dy * f;
      b.vx -= dx * f; b.vy -= dy * f;
    }
  }
  for (const [i, j] of edges) {
    const a = nodes[i], b = nodes[j];
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = ((d - 70) / d) * 0.06 * alpha;
    a.vx += dx * f; a.vy += dy * f;
    b.vx -= dx * f; b.vy -= dy * f;
  }
  let moved = 0;
  for (const p of nodes) {
    // A light pull to the middle keeps separate clusters on screen.
    p.vx -= p.x * 0.004 * alpha;
    p.vy -= p.y * 0.004 * alpha;
    p.vx *= 0.6; p.vy *= 0.6;
    if (p.fixed) { p.vx = p.vy = 0; continue; }
    const v = Math.min(Math.hypot(p.vx, p.vy), 40);
    const s = v / (Math.hypot(p.vx, p.vy) || 1);
    p.x += p.vx * s; p.y += p.vy * s;
    moved += v;
  }
  return moved / n;
}

/** Settles a graph without drawing, for tests and for a first frame that isn't a tangle. */
export function settle(g: Graph, steps = 300) {
  for (let k = 0; k < steps; k++) tick(g, 1 - k / steps);
}
