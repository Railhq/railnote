import { createPlayer, buildProjectTimeline, toProject, type ProjectRenderer } from "@canviz-engine";

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

/** Where each scene and step starts, for the "scene 2/5" or "step 3/8" label. */
interface Marks { scenes: number[]; steps: number[] }

function marksOf(project: any): Marks {
  const timeline = buildProjectTimeline(project);
  const steps: number[] = [];
  for (const slice of timeline.slices) {
    let acc = slice.startMs;
    for (const st of project.diagrams[slice.sceneIndex].steps ?? []) { steps.push(acc); acc += st.durationMs ?? 0; }
  }
  return { scenes: timeline.slices.map((s) => s.startMs), steps };
}

const indexAt = (starts: number[], t: number) => {
  let i = 0;
  while (i < starts.length - 1 && t >= starts[i + 1]) i++;
  return i;
};

/**
 * Canvas player for one explainer: a single scene or a multi-scene project, drawn by
 * @opencanviz/player so scene transitions play as they do on the site. Call destroy() when its
 * element goes away.
 */
export class CanvizPlayer {
  private canvas: HTMLCanvasElement;
  private stage: HTMLDivElement;
  private playBtn: HTMLButtonElement;
  private scrub: HTMLInputElement;
  private timeLabel: HTMLElement;
  private renderer: ProjectRenderer | null = null;
  private marks: Marks = { scenes: [0], steps: [] };
  private total = 0;
  private t = 0;
  private playing = false;
  private raf = 0;
  private lastTick = 0;
  private visible = true;
  private builtFor = 0;
  private destroyed = false;
  private observers: { disconnect(): void }[] = [];
  /** Settles once fonts, icons and pictures are in and the frame on screen is final. */
  readonly ready: Promise<void>;

  constructor(private root: HTMLElement, private doc: DiagramData, private opts: PlayerOptions = {}) {
    root.classList.add("canviz-player");
    this.stage = el(root, "div", "canviz-stage");
    const project = toProject(doc);
    this.stage.style.aspectRatio = `${project.artboard.width} / ${project.artboard.height}`;
    this.canvas = el(this.stage, "canvas");
    try { this.marks = marksOf(project); } catch { /* label falls back to time only */ }

    const bar = el(root, "div", "canviz-controls");
    this.playBtn = el(bar, "button", "canviz-play");
    this.playBtn.setAttribute("aria-label", "Play");
    this.scrub = el(bar, "input", "canviz-scrub");
    this.scrub.type = "range";
    this.scrub.min = "0";
    this.scrub.max = "0";
    this.scrub.step = "10";
    this.timeLabel = el(bar, "span", "canviz-time");

    this.playBtn.onclick = () => (this.playing ? this.pause() : this.play());
    this.stage.onclick = () => (this.playing ? this.pause() : this.play());
    this.scrub.oninput = () => { this.t = Number(this.scrub.value); this.render(); };

    // The renderer draws at a fixed pixel size; rebuild it only when the block grows well past
    // what it was built for, so a wider window stays sharp without re-preparing on every pixel.
    const ro = new ResizeObserver(() => {
      if (this.renderer && this.wantedHeight() > this.builtFor * 1.25) void this.build();
    });
    ro.observe(this.stage);
    this.observers.push(ro);
    // Don't burn CPU animating explainers scrolled out of view.
    const io = new IntersectionObserver(([e]) => {
      this.visible = e.isIntersecting;
      if (this.visible && this.playing) this.loop();
    });
    io.observe(root);
    this.observers.push(io);

    this.updateControls();
    this.ready = this.build().then(() => {
      if (opts.autoplay && !this.destroyed) this.play();
    });
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

  /** Where the playhead is, in ms. */
  get time() {
    return this.t;
  }

  /** Jumps to `ms` (clamped to the explainer's length) and draws that frame. */
  seek(ms: number) {
    this.t = Math.max(0, Math.min(ms, this.total));
    this.render();
  }

  destroy() {
    this.destroyed = true;
    this.pause();
    this.observers.forEach((o) => o.disconnect());
  }

  private wantedHeight(): number {
    const h = this.stage.getBoundingClientRect().height || 360;
    return Math.min(2160, Math.max(240, Math.round(h * (window.devicePixelRatio || 1))));
  }

  private async build() {
    const height = this.wantedHeight();
    const r = await createPlayer(this.canvas, this.doc, { targetHeight: height, showCaptions: this.opts.captions !== false });
    if (this.destroyed) return;
    await r.imagesReady;
    this.renderer = r;
    this.builtFor = height;
    this.total = r.totalDurationMs;
    this.scrub.max = String(this.total);
    this.t = Math.min(this.t, this.total);
    this.render();
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

  private render() {
    if (!this.renderer) return;
    // Ending exactly on the last boundary evaluates past the final step; hold its last frame instead.
    this.renderer.renderFrameAt(Math.min(this.t, Math.max(0, this.total - 1)));
    this.updateControls();
  }

  private updateControls() {
    this.playBtn.textContent = this.playing ? "❚❚" : "▶";
    this.playBtn.setAttribute("aria-label", this.playing ? "Pause" : "Play");
    this.scrub.value = String(this.t);
    const { scenes, steps } = this.marks;
    const where = scenes.length > 1
      ? ` · scene ${indexAt(scenes, this.t) + 1}/${scenes.length}`
      : steps.length ? ` · step ${indexAt(steps, this.t) + 1}/${steps.length}` : "";
    this.timeLabel.textContent = `${fmt(this.t)} / ${fmt(this.total)}${where}`;
  }
}
