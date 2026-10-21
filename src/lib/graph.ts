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
  /** Where the note sits on the transit map: a grid point near its force position. */
  mx?: number;
  my?: number;
}

export interface TransitLine {
  group: string;
  /** Node indexes in the order the line runs through them. */
  stops: number[];
}

export interface TransitMap {
  lines: TransitLine[];
  /** Notes linked to notes in another folder: where you'd change lines. */
  interchanges: Set<number>;
}

export const GRID = 48;

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
      mx: o?.mx,
      my: o?.my,
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

/**
 * Lays the graph out as a transit map: each note snaps to the nearest free grid point by its force
 * position (notes already placed stay put), and each folder becomes a line running through its notes
 * nearest-first.
 */
export function transitMap(g: Graph, grid = GRID): TransitMap {
  const { nodes, edges } = g;
  const taken = new Set<string>();
  const key = (cx: number, cy: number) => `${cx},${cy}`;
  for (const n of nodes) if (n.mx != null && n.my != null) taken.add(key(Math.round(n.mx / grid), Math.round(n.my / grid)));
  // Each folder's notes are drawn toward their middle first, so lines cross each other less.
  const mid = new Map<string, [number, number, number]>();
  for (const n of nodes) { const m = mid.get(n.group) ?? [0, 0, 0]; mid.set(n.group, [m[0] + n.x, m[1] + n.y, m[2] + 1]); }
  const target = (n: GraphNode): [number, number] => {
    const [sx, sy, c] = mid.get(n.group)!;
    return [n.x + (sx / c - n.x) * 0.4, n.y + (sy / c - n.y) * 0.4];
  };
  const order = nodes.map((_, i) => i).filter((i) => nodes[i].mx == null).sort((a, b) => nodes[b].degree - nodes[a].degree);
  for (const i of order) {
    const n = nodes[i];
    const [tx, ty] = target(n);
    const cx = Math.round(tx / grid), cy = Math.round(ty / grid);
    // The nearest free point, searching outward ring by ring.
    let best: [number, number] | null = null;
    for (let r = 0; !best; r++) {
      let bestD = Infinity;
      for (let dx = -r; dx <= r; dx++)
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || taken.has(key(cx + dx, cy + dy))) continue;
          const d = Math.hypot((cx + dx) * grid - tx, (cy + dy) * grid - ty);
          if (d < bestD) (bestD = d), (best = [cx + dx, cy + dy]);
        }
    }
    taken.add(key(best[0], best[1]));
    n.mx = best[0] * grid;
    n.my = best[1] * grid;
  }

  const byGroup = new Map<string, number[]>();
  nodes.forEach((n, i) => byGroup.set(n.group, [...(byGroup.get(n.group) ?? []), i]));
  const lines: TransitLine[] = [];
  for (const [group, members] of byGroup) {
    if (members.length < 2) continue;
    // Start from the end of the line: the stop furthest from the others' middle.
    const mx = members.reduce((t, i) => t + nodes[i].mx!, 0) / members.length;
    const my = members.reduce((t, i) => t + nodes[i].my!, 0) / members.length;
    let at = members.reduce((a, b) => (Math.hypot(nodes[b].mx! - mx, nodes[b].my! - my) > Math.hypot(nodes[a].mx! - mx, nodes[a].my! - my) ? b : a));
    const left = new Set(members);
    const stops = [at];
    left.delete(at);
    while (left.size) {
      let next = -1, nd = Infinity;
      for (const j of left) {
        const d = Math.hypot(nodes[j].mx! - nodes[at].mx!, nodes[j].my! - nodes[at].my!);
        if (d < nd) (nd = d), (next = j);
      }
      stops.push(next);
      left.delete(next);
      at = next;
    }
    lines.push({ group, stops: untangle(stops, (i) => [nodes[i].mx!, nodes[i].my!]) });
  }

  const interchanges = new Set<number>();
  for (const [i, j] of edges) if (nodes[i].group !== nodes[j].group) (interchanges.add(i), interchanges.add(j));
  return { lines, interchanges };
}

/**
 * The corner points of a track from a to b that runs only straight or at 45 degrees: along the
 * longer axis first, then diagonally into b.
 */
export function octilinear(ax: number, ay: number, bx: number, by: number): [number, number][] {
  const dx = bx - ax, dy = by - ay;
  const adx = Math.abs(dx), ady = Math.abs(dy);
  if (!adx || !ady || adx === ady) return [];
  return adx > ady ? [[ax + Math.sign(dx) * (adx - ady), ay]] : [[ax, ay + Math.sign(dy) * (ady - adx)]];
}

/** Shortens a line by reversing any stretch that makes it longer (2-opt), which also undoes self-crossings. */
function untangle(stops: number[], at: (i: number) => [number, number]): number[] {
  const d = (a: number, b: number) => { const [ax, ay] = at(a), [bx, by] = at(b); return Math.hypot(ax - bx, ay - by); };
  const s = [...stops];
  for (let pass = 0, better = true; better && pass < 20; pass++) {
    better = false;
    for (let i = 0; i < s.length - 2; i++)
      for (let j = i + 2; j < s.length; j++) {
        const after = j + 1 < s.length ? d(s[i], s[j]) + d(s[i + 1], s[j + 1]) : d(s[i], s[j]);
        const before = j + 1 < s.length ? d(s[i], s[i + 1]) + d(s[j], s[j + 1]) : d(s[i], s[i + 1]);
        if (after < before - 1e-6) (s.splice(i + 1, j - i, ...s.slice(i + 1, j + 1).reverse()), (better = true));
      }
  }
  return s;
}
