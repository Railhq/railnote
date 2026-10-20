// Stand-in when the build has no openCanviz engine checkout. Also the type surface tsc checks against.
const missing = (): any => {
  throw new Error("explainer engine not bundled in this build");
};
export const evaluateAt: (t: number, steps: any[], paths: any, nodes: any[], edges: any[]) => any = missing;
export const drawScene: (ctx: CanvasRenderingContext2D, state: any, w: number, h: number, opts: any) => void = missing;
export const normalizeStepsToFullSnapshots: (steps: any[]) => any[] = missing;
export const parseSvgStringToNode: (svg: string, x: number, y: number) => any = missing;
export const assetResolver: { resolve(asset: any): Promise<any> } = { resolve: missing };
export const available: boolean = false;
