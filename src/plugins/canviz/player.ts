import { evaluateAt, drawScene, normalizeStepsToFullSnapshots } from "@canviz-engine";
import { resolveSvgAssets } from "./assets";

export interface DiagramData {
  nodes?: any[];
  edges?: any[];
  steps?: any[];
  paths?: Record<string, any>;
  artboard?: { x: number; y: number; width: number; height: number; background?: string; bg?: any };
  metadata?: { title?: string };
}

export interface PlayerOptions {
  autoplay?: boolean;
  loop?: boolean;
  captions?: boolean;
  speed?: number;
}

interface Box { x: number; y: number; width: number; height: number }

// Artboard the doc declares, else the bounds of its base nodes with some padding.
function resolveArtboard(d: DiagramData): Box {
  const a = d.artboard;
  if (a && a.width > 0 && a.height > 0) return a;
  const nodes = d.nodes ?? [];
  if (nodes.length === 0) return { x: -640, y: -360, width: 1280, height: 720 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const w = n.width ?? 0, h = n.height ?? 0;
    minX = Math.min(minX, n.x - w / 2); maxX = Math.max(maxX, n.x + w / 2);
    minY = Math.min(minY, n.y - h / 2); maxY = Math.max(maxY, n.y + h / 2);
  }
  const pad = 60;
  return { x: minX - pad, y: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };
}

function el<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent.appendChild(e);
  return e;
}

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Canvas player for one DiagramData doc. Call destroy() when its element goes away. */
export class CanvizPlayer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private playBtn: HTMLButtonElement;
  private scrub: HTMLInputElement;
  private timeLabel: HTMLElement;
  private steps: any[];
  private nodes: any[];
  private edges: any[];
  private paths: Record<string, any>;
  private artboard: Box;
  private background: string;
  private bg: any;
  private boundaries: number[] = [];
  private total = 0;
  private t = 0;
  private playing = false;
  private raf = 0;
  private lastTick = 0;
  private visible = true;
  private observers: { disconnect(): void }[] = [];
  /** Settles once icons are parsed and the frame on screen is final. */
  readonly ready: Promise<void>;

  constructor(private root: HTMLElement, data: DiagramData, private opts: PlayerOptions = {}) {
    this.nodes = data.nodes ?? [];
    this.edges = data.edges ?? [];
    this.paths = data.paths ?? {};
    // The engine assumes full snapshots; delta-format docs come out blank past step 0 without this.
    this.steps = (data.steps?.length ? normalizeStepsToFullSnapshots(data.steps) : []) as any[];
    this.artboard = resolveArtboard(data);
    this.background = data.artboard?.background ?? "#ffffff";
    this.bg = data.artboard?.bg ?? null;

    let acc = 0;
    this.boundaries = [0];
    for (const s of this.steps) { acc += s.durationMs ?? 0; this.boundaries.push(acc); }
    this.total = acc;

    root.classList.add("canviz-player");
    const stage = el(root, "div", "canviz-stage");
    stage.style.aspectRatio = `${this.artboard.width} / ${this.artboard.height}`;
    this.canvas = el(stage, "canvas");
    this.ctx = this.canvas.getContext("2d")!;

    const bar = el(root, "div", "canviz-controls");
    this.playBtn = el(bar, "button", "canviz-play");
    this.playBtn.setAttribute("aria-label", "Play");
    this.scrub = el(bar, "input", "canviz-scrub");
    this.scrub.type = "range";
    this.scrub.min = "0";
    this.scrub.max = String(this.total);
    this.scrub.step = "10";
    this.timeLabel = el(bar, "span", "canviz-time");

    this.playBtn.onclick = () => (this.playing ? this.pause() : this.play());
    stage.onclick = () => (this.playing ? this.pause() : this.play());
    this.scrub.oninput = () => { this.t = Number(this.scrub.value); this.render(); };

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(stage);
    this.observers.push(ro);
    // Don't burn CPU animating explainers scrolled out of view.
    const io = new IntersectionObserver(([e]) => {
      this.visible = e.isIntersecting;
      if (this.visible && this.playing) this.loop();
    });
    io.observe(root);
    this.observers.push(io);

    this.resize();
    this.updateControls();
    if (opts.autoplay) this.play();
    // Icons draw blank until parsed; show the first frame now and redraw once they're in.
    const lists = [this.nodes, ...this.steps.map((s) => s.nodes ?? [])];
    this.ready = resolveSvgAssets(lists).then((patched) => { if (patched) this.render(); }, () => {});
  }

  play() {
    if (this.total === 0) return;
    if (this.t >= this.total) this.t = 0;
    this.playing = true;
    this.updateControls();
    this.loop();
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.updateControls();
  }

  /** Jumps to `ms` (clamped to the explainer's length) and draws that frame. */
  seek(ms: number) {
    this.t = Math.max(0, Math.min(ms, this.total));
    this.render();
  }

  destroy() {
    this.pause();
    this.observers.forEach((o) => o.disconnect());
  }

  private loop() {
    cancelAnimationFrame(this.raf);
    this.lastTick = performance.now();
    const tick = (now: number) => {
      if (!this.playing || !this.visible) return;
      this.t += (now - this.lastTick) * (this.opts.speed ?? 1);
      this.lastTick = now;
      if (this.t >= this.total) {
        if (this.opts.loop) this.t %= this.total;
        else { this.t = this.total; this.render(); this.pause(); return; }
      }
      this.render();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private resize() {
    const rect = this.canvas.parentElement!.getBoundingClientRect();
    if (rect.width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.render();
  }

  private render() {
    const { width: w, height: h } = this.canvas;
    if (w === 0 || h === 0) return;
    const a = this.artboard;
    const camera = { x: a.x + a.width / 2, y: a.y + a.height / 2, zoom: Math.min(w / a.width, h / a.height) };
    // Ending exactly on the last boundary evaluates past the final step; hold its last frame instead.
    const t = Math.min(this.t, Math.max(0, this.total - 1));
    const state = evaluateAt(t, this.steps, this.paths, this.nodes, this.edges);
    this.ctx.clearRect(0, 0, w, h);
    drawScene(this.ctx, state, w, h, {
      flowEnabled: true,
      backgroundColor: this.background,
      background: this.bg,
      currentTimeMs: t,
      camera,
      baseNodes: this.nodes,
      showCaptions: this.opts.captions !== false,
    });
    this.updateControls();
  }

  private updateControls() {
    this.playBtn.textContent = this.playing ? "❚❚" : "▶";
    this.playBtn.setAttribute("aria-label", this.playing ? "Pause" : "Play");
    this.scrub.value = String(this.t);
    let step = 0;
    while (step < this.boundaries.length - 2 && this.t >= this.boundaries[step + 1]) step++;
    this.timeLabel.textContent = `${fmt(this.t)} / ${fmt(this.total)} · step ${Math.min(step + 1, this.steps.length)}/${this.steps.length}`;
  }
}
