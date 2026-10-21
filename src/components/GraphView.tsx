import { useEffect, useRef, useState } from "react";
import { whereFrom, type OpenWhere } from "../editor/hooks";
import { buildGraph, settle, tick, type Graph, type GraphNode } from "../lib/graph";
import type { Workspace } from "../workspace";

interface Props {
  ws: Workspace;
  current: string | null;
  onOpen(path: string, where: OpenWhere): void;
}

type Mode = "vault" | "note";
const SAVED = "railnote:graph";

interface View { x: number; y: number; k: number }

const radius = (n: GraphNode) => 3.5 + Math.sqrt(n.degree) * 1.7;

/** Every note as a stop and every link as a track, laid out by force. Click a stop to open it. */
export function GraphView({ ws, current, onOpen }: Props) {
  const saved = (() => {
    try { return JSON.parse(localStorage.getItem(SAVED) ?? "{}"); } catch { return {}; }
  })();
  const [mode, setMode] = useState<Mode>(saved.mode === "note" && current ? "note" : "vault");
  const [depth, setDepth] = useState<number>(saved.depth ?? 1);
  const [orphans, setOrphans] = useState<boolean>(saved.orphans ?? false);
  const [counts, setCounts] = useState({ nodes: 0, edges: 0 });
  const [groups, setGroups] = useState<string[]>([]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const graph = useRef<Graph>({ nodes: [], edges: [], groups: [] });
  const view = useRef<View>({ x: 0, y: 0, k: 1 });
  const hover = useRef<GraphNode | null>(null);
  const alpha = useRef(0);
  const raf = useRef(0);
  const draw = useRef<() => void>(() => {});
  const fitNext = useRef(true);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  const around = mode === "note" ? current : null;

  useEffect(() => {
    try { localStorage.setItem(SAVED, JSON.stringify({ mode, depth, orphans })); } catch { /* per-viewer nicety only */ }
  }, [mode, depth, orphans]);

  // Starts the layout running again, cooling as it goes, and draws each frame until it's still.
  const heat = (to = 0.6) => {
    alpha.current = Math.max(alpha.current, to);
    if (raf.current) return;
    const step = () => {
      const moved = tick(graph.current, alpha.current);
      alpha.current *= 0.985;
      draw.current();
      raf.current = alpha.current > 0.02 || moved > 0.05 ? requestAnimationFrame(step) : 0;
    };
    raf.current = requestAnimationFrame(step);
  };

  const fit = () => {
    const c = canvas.current, ns = graph.current.nodes;
    if (!c || !ns.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of ns) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
    const w = c.clientWidth, h = c.clientHeight, pad = 70;
    const k = Math.min(2.2, (w - pad * 2) / Math.max(x1 - x0, 1), (h - pad * 2) / Math.max(y1 - y0, 1));
    view.current = { k, x: w / 2 - ((x0 + x1) / 2) * k, y: h / 2 - ((y0 + y1) / 2) * k };
    draw.current();
  };

  // (Re)build when the vault changes or the question does, keeping where nodes already sit.
  useEffect(() => {
    const rebuild = (first: boolean) => {
      const prev = graph.current;
      const g = buildGraph(ws.index, { around, depth, orphans }, prev);
      const fresh = g.nodes.filter((n) => !prev.nodes.some((p) => p.id === n.id)).length;
      graph.current = g;
      setCounts({ nodes: g.nodes.length, edges: g.edges.length });
      setGroups(g.groups);
      if (first) {
        settle(g, 240);
        if (fitNext.current) fit();
        fitNext.current = false;
        heat(0.15);
      } else if (fresh) heat(0.4);
      else draw.current();
    };
    fitNext.current = true;
    rebuild(true);
    return ws.index.subscribe(() => rebuild(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, around, depth, orphans]);

  useEffect(() => {
    const c = canvas.current!;
    const ctx = c.getContext("2d")!;
    const style = getComputedStyle(c);
    const v = (name: string) => style.getPropertyValue(name).trim();

    draw.current = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth, h = c.clientHeight;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      const { nodes, edges, groups: gs } = graph.current;
      const { x: ox, y: oy, k } = view.current;
      const colour = (n: GraphNode) => (n.group ? v(`--line-${(gs.indexOf(n.group) % 4) + 1}`) : v("--line-0"));
      const hot = hover.current;
      const near = new Set<GraphNode>();
      if (hot) {
        near.add(hot);
        for (const [i, j] of edges) {
          if (nodes[i] === hot) near.add(nodes[j]);
          if (nodes[j] === hot) near.add(nodes[i]);
        }
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      ctx.lineWidth = 1;
      for (const [i, j] of edges) {
        const a = nodes[i], b = nodes[j];
        const lit = hot && (a === hot || b === hot);
        ctx.strokeStyle = lit ? v("--ink-2") : v("--graph-edge");
        ctx.globalAlpha = hot && !lit ? 0.35 : 1;
        ctx.beginPath();
        ctx.moveTo(ox + a.x * k, oy + a.y * k);
        ctx.lineTo(ox + b.x * k, oy + b.y * k);
        ctx.stroke();
      }
      for (const n of nodes) {
        const r = radius(n) * Math.min(Math.max(k, 0.6), 1.6);
        const sx = ox + n.x * k, sy = oy + n.y * k;
        ctx.globalAlpha = hot && !near.has(n) ? 0.35 : 1;
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        // Amber means "you are here", the same as in the sidebar.
        ctx.fillStyle = n.id === current ? v("--signal") : colour(n);
        ctx.fill();
        ctx.lineWidth = n === hot ? 2.5 : 1.5;
        ctx.strokeStyle = v("--paper");
        ctx.stroke();
      }
      // Names: everywhere once zoomed in, else only for the hovered note, its neighbours and this note.
      ctx.globalAlpha = 1;
      ctx.font = `500 12px ${v("--sans")}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (const n of nodes) {
        const show = k >= 1.3 || near.has(n) || n.id === current || nodes.length <= 24;
        if (!show) continue;
        const sx = ox + n.x * k, sy = oy + n.y * k + radius(n) * Math.min(Math.max(k, 0.6), 1.6) + 4;
        ctx.lineWidth = 4;
        ctx.strokeStyle = v("--paper");
        ctx.globalAlpha = hot && !near.has(n) ? 0.4 : 1;
        ctx.strokeText(n.name, sx, sy);
        ctx.fillStyle = n === hot || n.id === current ? v("--ink") : v("--ink-2");
        ctx.fillText(n.name, sx, sy);
      }
      ctx.globalAlpha = 1;
    };

    // Screen positions, for tests to click on.
    (c as unknown as { railnoteNodes: () => unknown }).railnoteNodes = () =>
      graph.current.nodes.map((n) => ({ id: n.id, x: view.current.x + n.x * view.current.k, y: view.current.y + n.y * view.current.k }));

    const ro = new ResizeObserver(() => draw.current());
    ro.observe(c);
    const dark = matchMedia("(prefers-color-scheme: dark)");
    const redraw = () => draw.current();
    dark.addEventListener("change", redraw);
    draw.current();
    return () => {
      ro.disconnect();
      dark.removeEventListener("change", redraw);
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const pick = (e: { clientX: number; clientY: number }): GraphNode | null => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const { x, y, k } = view.current;
    let best: GraphNode | null = null, bestD = Infinity;
    for (const n of graph.current.nodes) {
      const d = Math.hypot(x + n.x * k - px, y + n.y * k - py);
      if (d < Math.max(radius(n) * Math.max(k, 0.6) + 5, 9) && d < bestD) { best = n; bestD = d; }
    }
    return best;
  };

  // Drag a node to move it, drag the background to pan, click a node to open it.
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvas.current!;
    c.setPointerCapture(e.pointerId);
    const node = pick(e);
    const start = { x: e.clientX, y: e.clientY, vx: view.current.x, vy: view.current.y };
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 3) moved = true;
      if (!moved) return;
      if (node) {
        const r = c.getBoundingClientRect();
        node.fixed = true;
        node.x = (ev.clientX - r.left - view.current.x) / view.current.k;
        node.y = (ev.clientY - r.top - view.current.y) / view.current.k;
        heat(0.3);
      } else {
        view.current.x = start.vx + ev.clientX - start.x;
        view.current.y = start.vy + ev.clientY - start.y;
        draw.current();
      }
    };
    const up = (ev: PointerEvent) => {
      c.removeEventListener("pointermove", move);
      c.removeEventListener("pointerup", up);
      if (node) node.fixed = false;
      if (node && !moved) openRef.current(node.id, whereFrom(ev as unknown as MouseEvent));
    };
    c.addEventListener("pointermove", move);
    c.addEventListener("pointerup", up);
  };

  const onMove = (e: React.PointerEvent) => {
    if (e.buttons) return;
    const n = pick(e);
    if (n !== hover.current) {
      hover.current = n;
      canvas.current!.style.cursor = n ? "pointer" : "grab";
      canvas.current!.title = n ? n.id : "";
      draw.current();
    }
  };

  // Wheel and trackpad pinch zoom around the pointer.
  useEffect(() => {
    const c = canvas.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const { x, y, k } = view.current;
      const nk = Math.min(6, Math.max(0.1, k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025))));
      view.current = { k: nk, x: px - ((px - x) / k) * nk, y: py - ((py - y) / k) * nk };
      draw.current();
    };
    c.addEventListener("wheel", wheel, { passive: false });
    return () => c.removeEventListener("wheel", wheel);
  }, []);

  const zoomBy = (f: number) => {
    const c = canvas.current!;
    const px = c.clientWidth / 2, py = c.clientHeight / 2;
    const { x, y, k } = view.current;
    const nk = Math.min(6, Math.max(0.1, k * f));
    view.current = { k: nk, x: px - ((px - x) / k) * nk, y: py - ((py - y) / k) * nk };
    draw.current();
  };

  const empty = counts.nodes === 0;
  const name = current ? ws.index.notes.get(current)?.name : null;

  return (
    <div className="graph-view">
      <div className="graph-bar">
        <div className="seg" role="group" aria-label="What to show">
          <button className={mode === "vault" ? "on" : ""} onClick={() => setMode("vault")}>Whole vault</button>
          <button className={mode === "note" ? "on" : ""} disabled={!current} onClick={() => setMode("note")} title={current ? `Notes linked with ${name}` : "Open a note first"}>
            {name ? `Around ${name}` : "Around this note"}
          </button>
        </div>
        {mode === "note" ? (
          <label className="graph-opt">
            Links away
            <select value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
              {[1, 2, 3].map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
        ) : (
          <label className="graph-opt">
            <input type="checkbox" checked={orphans} onChange={(e) => setOrphans(e.target.checked)} /> Notes without links
          </label>
        )}
        <span className="graph-count">{counts.nodes} notes, {counts.edges} links</span>
        <span className="graph-zoom">
          <button className="ghost" onClick={() => zoomBy(1 / 1.3)} aria-label="Zoom out">−</button>
          <button className="ghost" onClick={fit}>Fit</button>
          <button className="ghost" onClick={() => zoomBy(1.3)} aria-label="Zoom in">+</button>
        </span>
      </div>
      <div className="graph-stage">
        <canvas
          ref={canvas}
          role="img"
          aria-label={`Graph of ${counts.nodes} notes and ${counts.edges} links`}
          onPointerDown={onPointerDown}
          onPointerMove={onMove}
          onPointerLeave={() => { hover.current = null; draw.current(); }}
          onDoubleClick={(e) => { if (!pick(e)) fit(); }}
        />
        {empty && (
          <p className="graph-empty">
            {mode === "note" ? "This note has no links yet. Link a note with [[its name]] to see it here." : "No notes link to each other yet. Write [[a note's name]] in a note to draw a link, or show notes without links."}
          </p>
        )}
        {groups.length > 0 && !empty && (
          <ul className="graph-legend">
            {groups.slice(0, 8).map((g, i) => (
              <li key={g}><i style={{ background: `var(--line-${(i % 4) + 1})` }} />{g}</li>
            ))}
            {current && <li><i style={{ background: "var(--signal)" }} />This note</li>}
          </ul>
        )}
      </div>
    </div>
  );
}
