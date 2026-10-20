// The openCanviz canvas engine, compiled from its source checkout (the `@engine` alias in
// vite.config.ts). Same entry points the export pipeline uses, so a note plays what an MP4 shows.
// @ts-nocheck
import "./hands";
export { evaluateAt } from "@engine/utils/animation-utils";
export { drawScene } from "@engine/utils/rendering-utils";
export { normalizeStepsToFullSnapshots } from "@engine/utils/step-resolution";
export { parseSvgStringToNode } from "@engine/utils/svg-utils";
export { assetResolver } from "@engine/assets/AssetResolver";
export const available = true;

