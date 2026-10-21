// Stand-in when the build has no openCanviz checkout. Also the type surface tsc checks against.
const missing = (): any => {
  throw new Error("explainer engine not bundled in this build");
};
export interface ProjectRenderer {
  totalDurationMs: number;
  pxW: number;
  pxH: number;
  imagesReady: Promise<void>;
  renderFrameAt(tMs: number): void;
  prepareFrameAt(tMs: number): Promise<void>;
}
export const createPlayer: (canvas: HTMLCanvasElement, doc: any, opts?: { targetHeight?: number; showCaptions?: boolean; flowEnabled?: boolean }) => Promise<ProjectRenderer> = missing;
export const buildProjectTimeline: (project: any) => { slices: { startMs: number; durationMs: number; sceneIndex: number }[]; totalDurationMs: number } = missing;
export const toProject: (doc: any) => any = missing;
export const available: boolean = false;
